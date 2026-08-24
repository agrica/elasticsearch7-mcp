/**
 * Keep one class of stray asynchronous error from killing the session.
 *
 * Cancelling a request makes the 7.x Elasticsearch client emit a second
 * `RequestAbortedError` outside any promise chain: the request it had queued is
 * resumed from an EventEmitter callback (`Transport.js`, the `product-check`
 * listener), notices `meta.aborted`, and hands the error to a callback whose
 * promise has already settled. The tool call itself rejects correctly — this is
 * an extra, unowned copy.
 *
 * Unowned means unhandled, and an unhandled exception ends the process. For a
 * stdio server that is the whole MCP session, killed by a client doing something
 * it is entitled to do. So it is tolerated here.
 *
 * Reproduced against the mocked connection; whether a real cluster's HTTP
 * connection behaves the same is untested, which is a reason to keep the net,
 * not to remove it.
 *
 * The net is deliberately narrow. Only this one error name passes; anything else
 * is logged and exits non-zero, which is what an unexpected exception should do.
 * A blanket handler here would turn every future bug into silence.
 */
export function isLateAbortArtifact(error: unknown): boolean {
  return error instanceof Error && error.name === "RequestAbortedError";
}

/**
 * `onFatal` decides what an *unexpected* stray error does. The default ends the
 * process, which is what a server should do. The test suite overrides it so a
 * genuine unhandled error is reported by the runner instead of killing the
 * worker, where it would read as a crash rather than as a failing test.
 */
export function installProcessSafetyNet(
  onFatal: (kind: string, message: string) => void = (kind, message) => {
    console.error(`Fatal (${kind}): ${message}`);
    process.exit(1);
  }
): void {
  const handle = (kind: string) => (reason: unknown) => {
    if (isLateAbortArtifact(reason)) {
      console.error(
        `Ignored a late ${(reason as Error).name} from the Elasticsearch client: ` +
          `a cancelled request reported itself twice. The call it belongs to already failed.`
      );
      return;
    }

    const message =
      reason instanceof Error ? reason.stack || reason.message : String(reason);
    onFatal(kind, message);
  };

  process.on("uncaughtException", handle("uncaughtException"));
  process.on("unhandledRejection", handle("unhandledRejection"));
}
