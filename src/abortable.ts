/**
 * The shape of what a 7.x client call returns. Described structurally rather
 * than imported: the client declares `TransportRequestPromise` internally but
 * does not export it, and the deep `lib/Transport.js` path is not an export
 * entry either. Structural typing also keeps this honest — all this helper
 * needs is a promise that can be aborted.
 */
type AbortableRequest<T> = Promise<T> & { abort: () => void };

/**
 * Stop an in-flight Elasticsearch request when the MCP client cancels the call.
 *
 * The SDK gives every tool handler an `AbortSignal` and aborts it on
 * `notifications/cancelled` (and on the connection closing). Without this, a
 * cancelled `delete_by_query` or a search over a large index keeps running on
 * the cluster and its answer is thrown away — the caller stopped listening, the
 * cluster did not stop working.
 *
 * The 7.x client has no `signal` option: `TransportRequestOptions` does not
 * carry one. Cancellation there is `.abort()` on the returned promise, which is
 * why this wraps the call rather than passing an option through.
 */
export function abortable<T>(
  request: AbortableRequest<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) return request;

  // Already cancelled before the request left: abort at once rather than let it
  // reach the cluster and be discarded on return.
  if (signal.aborted) {
    request.abort();
    return request;
  }

  const onAbort = () => request.abort();
  signal.addEventListener("abort", onAbort, { once: true });

  // Detach on settle, or a long-lived session accumulates one listener per call
  // on the same signal.
  return request.finally(() => signal.removeEventListener("abort", onAbort));
}
