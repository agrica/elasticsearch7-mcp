import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** A single text fragment of a tool's answer. */
export type TextFragment = { type: "text"; text: string };

/**
 * What every tool function returns. Deliberately narrower than the protocol's
 * `CallToolResult` — this server only ever emits text — but checked against it
 * just below, so an SDK change that breaks the shape fails the build instead of
 * surfacing as an opaque protocol error at runtime.
 *
 * `isError` is what the specification requires of a failed tool call, and it is
 * the only machine-readable signal a client has: without it, telling a failure
 * from a success means string-matching the text, which is not a contract.
 * Omitted on success — the protocol defaults it to false.
 *
 * `structuredContent` is the machine-readable answer, present only on the four
 * tools whose result is genuinely tabular. It is not optional decoration there:
 * the SDK rejects a successful result that omits it when the tool declared an
 * `outputSchema`, so the two go together or neither does. It also counts
 * against the byte budget, because it reaches the caller's context exactly like
 * the text does — see src/outputBudget.ts.
 */
export type ToolResult = {
  content: TextFragment[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

type Assert<T extends true> = T;
export type ToolResultMatchesProtocol = Assert<
  ToolResult extends CallToolResult ? true : false
>;

export function textFragment(text: string): TextFragment {
  return { type: "text", text };
}

/**
 * Tools never throw: a failure has to reach the calling model as readable
 * content, never as a transport-level exception. `context` prefixes the stderr
 * log — stdout belongs to the MCP protocol and must not be written to.
 */
export function toolError(context: string, error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${context}: ${message}`);
  // Only `error.message` reaches the model, never the error object: an ES
  // client error carries the connection in `meta`, and a node URL may embed
  // basic-auth credentials.
  return { content: [textFragment(`Error: ${message}`)], isError: true };
}

/**
 * A refusal: the tool declined to act, and nothing was sent to the cluster.
 *
 * Distinct from `toolError` only in that there is no exception to log — but it
 * is just as much a failed call, so it carries `isError` too. A refusal
 * reported as a success would let a model conclude a delete had happened.
 */
export function toolRefusal(message: string): ToolResult {
  return { content: [textFragment(`Error: ${message}`)], isError: true };
}
