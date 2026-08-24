import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** A single text fragment of a tool's answer. */
export type TextFragment = { type: "text"; text: string };

/**
 * What every tool function returns. Deliberately narrower than the protocol's
 * `CallToolResult` — this server only ever emits text — but checked against it
 * just below, so an SDK change that breaks the shape fails the build instead of
 * surfacing as an opaque protocol error at runtime.
 */
export type ToolResult = { content: TextFragment[] };

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
  return { content: [textFragment(`Error: ${message}`)] };
}
