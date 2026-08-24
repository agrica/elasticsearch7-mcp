import { textFragment, type TextFragment, type ToolResult } from "./toolResult.js";

/**
 * A ceiling on how much one tool result may return.
 *
 * The reason this exists: a `list_shards` call on a cluster of 365 daily indices
 * returned 385 469 bytes — around 96 000 tokens — in a single result, while the
 * whole `tools/list` payload this project carefully budgets is 15 871. The tool
 * list was rationed and the tool output was not.
 *
 * 32 KiB is roughly 8 000 tokens: large enough to answer a real question about a
 * cluster, small enough that one unlucky call cannot end a session. Deployments
 * differ, so `ES_MAX_RESULT_BYTES` overrides it.
 */
export const DEFAULT_MAX_RESULT_BYTES = 32_768;

/**
 * The budget in force for this process, set once from the configuration.
 *
 * Module state rather than a parameter on all twenty-six tool functions, and the
 * distinction from cancellation is the reason: a cancellation signal belongs to
 * one call and has to travel with it, whereas the budget is a property of the
 * deployment and identical for every call this process serves. Threading it
 * would add an argument everywhere to say the same thing every time.
 */
let configuredMaxBytes = DEFAULT_MAX_RESULT_BYTES;

export function setResultBudget(maxBytes: number): void {
  configuredMaxBytes = maxBytes;
}

export type BudgetedParts = {
  /**
   * Kept whatever the budget: the counts, the unhealthy shards, the answer. If
   * the summary alone overruns, it is truncated with a marker rather than
   * dropped — a caller that loses the summary has lost the answer.
   */
  summary: TextFragment[];

  /** Trimmed first, and entirely if need be: raw dumps, per-item listings. */
  detail?: TextFragment[];

  /**
   * How to ask a smaller question — "pass an index", "narrow `pattern`". Printed
   * with the omission notice, because a caller told only that data was cut
   * cannot act on it.
   */
  hint?: string;

  /** Overrides the configured budget. Tests use it; tools should not. */
  maxBytes?: number;
};

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Split a collection into several JSON fragments instead of one.
 *
 * A single fragment is all-or-nothing against the budget: measured on 2190
 * shards, one 380 KB dump was dropped whole and `verbose` returned 145 bytes —
 * a summary and an apology. Chunked, the budget fills with as many records as
 * fit and reports the remainder, which is what a caller asking for detail
 * wanted.
 *
 * 50 per chunk keeps the fragment count sane — 2190 shards become 44 fragments,
 * not 2190 — while making the granularity of the trim fine enough to be useful.
 */
export function chunkedJson(records: unknown[], perChunk = 50): TextFragment[] {
  const fragments: TextFragment[] = [];
  for (let start = 0; start < records.length; start += perChunk) {
    const slice = records.slice(start, start + perChunk);
    fragments.push(
      textFragment(
        `[${start + 1}–${start + slice.length} of ${records.length}]\n` +
          JSON.stringify(slice, null, 2)
      )
    );
  }
  return fragments;
}

/**
 * Cut `text` to fit `limit` bytes, on a line boundary where one is close enough
 * to the cut, and say how much went.
 */
function truncateTo(text: string, limit: number): string {
  const notice = (omitted: number) =>
    `\n… [truncated, ${omitted} more bytes omitted]`;

  // Reserve room for the notice itself, or the result overruns the very budget
  // it is reporting on.
  const room = Math.max(0, limit - bytes(notice(bytes(text))));
  let cut = Buffer.from(text, "utf8").subarray(0, room).toString("utf8");

  // Drop a trailing partial line: half a JSON object or half a shard row is
  // worse than no line, because it reads as data.
  const lastBreak = cut.lastIndexOf("\n");
  if (lastBreak > room * 0.6) cut = cut.slice(0, lastBreak);

  return cut + notice(bytes(text) - bytes(cut));
}

/**
 * Assemble a tool result that fits a byte budget, and say plainly when it did
 * not fit.
 *
 * Silence is the failure mode being designed against here. A model handed a
 * truncated list with no notice cannot tell that the index it was looking for
 * was among the entries removed, so it concludes the index does not exist. The
 * omission notice is therefore not politeness — it is what keeps a trimmed
 * answer honest.
 */
export function budgeted(parts: BudgetedParts): ToolResult {
  const maxBytes = parts.maxBytes ?? configuredMaxBytes;
  const detail = parts.detail ?? [];

  const content: TextFragment[] = [];
  let used = 0;
  let truncatedSummary = false;

  for (const fragment of parts.summary) {
    const size = bytes(fragment.text);
    if (used + size <= maxBytes) {
      content.push(fragment);
      used += size;
      continue;
    }
    // The summary is never dropped, only cut — and only what does not fit.
    const room = maxBytes - used;
    if (room > 200) {
      const cut = truncateTo(fragment.text, room);
      content.push(textFragment(cut));
      used += bytes(cut);
    }
    truncatedSummary = true;
  }

  let included = 0;
  for (const fragment of detail) {
    const size = bytes(fragment.text);
    if (used + size > maxBytes) break;
    content.push(fragment);
    used += size;
    included += 1;
  }

  const omitted = detail.length - included;

  if (omitted > 0 || truncatedSummary) {
    const what =
      omitted > 0
        ? `${omitted} of ${detail.length} detail ${
            detail.length === 1 ? "section" : "sections"
          } omitted`
        : "the summary was truncated";

    content.push(
      textFragment(
        `[Result budget: ${what} to stay under ${maxBytes} bytes.` +
          `${parts.hint ? ` ${parts.hint}` : ""}]`
      )
    );
  }

  return { content };
}
