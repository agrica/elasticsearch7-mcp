import type { Client } from "@elastic/elasticsearch";
import { abortable } from "./abortable.js";

/**
 * A view of the Elasticsearch client whose requests are aborted when the MCP
 * client cancels the call.
 *
 * Binding cancellation to the *client* rather than threading an `AbortSignal`
 * through every tool is deliberate. There are twenty-six tool functions, and
 * `src/server.ts` re-exports all of them as this package's library surface:
 * adding a trailing `signal` parameter to each would change every public
 * signature, every test call and `scripts/smoke.mjs`, to express one thing —
 * "this request belongs to a call that can be cancelled". That belongs to the
 * client the tool was handed, not to its argument list.
 *
 * The consequence to know: a tool reached through this wrapper cancels, and a
 * tool handed the bare client does not. The register modules are the only place
 * that decides, which is why the wrapping happens there and nowhere else.
 */
export function withCancellation(client: Client, signal: AbortSignal): Client {
  return wrap(client, signal, 0) as Client;
}

/**
 * The one property a wrapper answers itself: the client it stands in front of.
 */
const TARGET = Symbol("elasticsearch7-mcp.proxyTarget");

/**
 * Recover the client behind a wrapper, or return a bare client unchanged.
 *
 * A wrapper exists per *call*, because the signal it binds belongs to that one
 * call. So anything wanting to remember something about the *cluster* across
 * calls cannot key on the object it was handed: two calls to the same cluster
 * arrive as two different objects, and a cache keyed on them never hits — it
 * silently degrades to no cache at all, which is the kind of defect that shows
 * up as a performance report months later rather than as a failing test.
 *
 * Keying on the index name in module state instead would be wrong for a
 * different reason: `scripts/measure-output.mjs` and the tests build several
 * clients against different fixtures under the same index names, and a
 * process-wide cache would hand one cluster's fields to another.
 */
export function unwrapClient(client: Client): Client {
  const target = (client as unknown as Record<symbol, unknown>)[TARGET];
  return (target as Client | undefined) ?? client;
}

/** A promise from a 7.x client call: awaitable, and abortable mid-flight. */
function isAbortable(value: unknown): value is Promise<unknown> & {
  abort: () => void;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function" &&
    typeof (value as { abort?: unknown }).abort === "function"
  );
}

function wrap<T extends object>(target: T, signal: AbortSignal, depth: number): T {
  return new Proxy(target, {
    get(obj, property) {
      if (property === TARGET) return obj;

      // `obj`, not the proxy, is the receiver: a getter or a method that uses
      // `this` then sees the real client. That is what keeps the client's own
      // internals — transport, connection pool, serializer — entirely
      // unproxied, and this wrapper a view rather than a reimplementation.
      const value = Reflect.get(obj, property);

      if (typeof value === "function") {
        return (...args: unknown[]) => {
          const result = (value as (...a: unknown[]) => unknown).apply(obj, args);
          // Not every method returns a request: `close()` yields a plain
          // promise, with nothing to abort.
          return isAbortable(result) ? abortable(result, signal) : result;
        };
      }

      // The API lives in namespaces — indices, cat, cluster, tasks — so the
      // wrapper has to follow them one level down. The depth cap is a
      // safeguard, not a requirement: a property returning the client itself
      // would otherwise recurse without end.
      if (value !== null && typeof value === "object" && depth < 3) {
        return wrap(value, signal, depth + 1);
      }

      return value;
    },
  });
}
