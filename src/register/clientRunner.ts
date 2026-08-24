import type { Client } from "@elastic/elasticsearch";
import type { ClientSource } from "../auth/clientSource.js";
import { withCancellation } from "../cancellable.js";
import { toolError, type ToolResult } from "../toolResult.js";

/**
 * What an authentication failure should say.
 *
 * `fetch` reports a refused connection as `TypeError: fetch failed` and puts the
 * actual reason — `ECONNREFUSED`, a DNS failure, a TLS mismatch — in `cause`.
 * Forwarding only the outer message would hand the model "Error: fetch failed",
 * which names neither the problem nor the component. The context is folded into
 * the text as well, because `toolError` logs its context to stderr but returns
 * only the message, and here the distinction between "the identity provider did
 * not answer" and "the cluster refused the request" is the whole diagnosis.
 */
function describeAuthFailure(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof Error && error.cause instanceof Error
      ? `: ${error.cause.message}`
      : "";

  return new Error(
    `Authentication failed before any request was sent: ${message}${cause}`
  );
}

/**
 * How every handler reaches the cluster.
 *
 * Two things happen here, and neither belongs in a tool's argument list. The
 * client is resolved — which with OAuth2 may mean obtaining a token — and it is
 * wrapped so its in-flight request aborts when the MCP client cancels the call.
 *
 * The `try` is the reason this exists rather than an inline `await source()`.
 * Handlers run *outside* the tool's own error handling, so a rejected token
 * request there would reach the SDK and become a JSON-RPC protocol error. This
 * whole repository is built the other way round: a failure must arrive as
 * readable content carrying `isError`, because the calling model has to be able
 * to read what went wrong. So authentication failures are caught here, and
 * nowhere else.
 *
 * `run` is not wrapped, deliberately: a tool function never throws — that is its
 * contract, asserted for all of them in `test/toolContract.test.ts` — so
 * catching around it would only hide a broken tool.
 */
export function clientRunner(source: ClientSource) {
  return async function call(
    extra: { signal: AbortSignal },
    run: (esClient: Client) => Promise<ToolResult>
  ): Promise<ToolResult> {
    let esClient: Client;

    try {
      esClient = await source();
    } catch (error) {
      // Distinct from a request the cluster refused: nothing was sent. The
      // message says so, because "401" and "the identity provider did not
      // answer" call for different fixes.
      return toolError("Authentication failed", describeAuthFailure(error));
    }

    return run(withCancellation(esClient, extra.signal));
  };
}
