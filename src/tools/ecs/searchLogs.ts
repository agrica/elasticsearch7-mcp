import { Client, estypes } from "@elastic/elasticsearch";
import { textFragment, toolError, toolRefusal, type ToolResult } from "../../toolResult.js";
import { budgeted } from "../../outputBudget.js";
import { KEYWORD_FIELDS, RENDERED_FIELDS, STACK_TRACE, TEXT_FIELDS, TIMESTAMP } from "./fields.js";
import { buildLogQuery, type LogFilters } from "./logQuery.js";

/**
 * The largest page this tool returns, and the default it returns.
 *
 * The ceiling matches `search`'s own for the same measured reason. The default is
 * twenty rather than the ceiling because the question is almost always "what is
 * happening", which twenty lines answer — and because the eighty lines nobody
 * read would have been paid for out of the caller's context.
 */
export const MAX_LOG_HITS = 100;
export const DEFAULT_LOG_HITS = 20;

type LogSource = Record<string, unknown>;

/** `a.b.c` out of a nested `_source`, since ECS documents may be either shape. */
function read(source: LogSource, path: string): unknown {
  if (path in source) return source[path];

  let cursor: unknown = source;
  for (const segment of path.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function text(source: LogSource, path: string): string {
  const value = read(source, path);
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * One event, one line.
 *
 * The column order is the order the question is asked in: when, how bad, who,
 * where, what. A missing field becomes a dash rather than being skipped, so the
 * columns stay in place down the page and a gap is visible as a gap.
 */
function renderLine(hit: estypes.SearchHit<LogSource>, verbose: boolean): string {
  const source = hit._source ?? {};
  const columns = [
    text(source, TIMESTAMP) || "-",
    text(source, KEYWORD_FIELDS.level) || "-",
    text(source, KEYWORD_FIELDS.service) || "-",
    text(source, KEYWORD_FIELDS.host) || "-",
  ];

  const errorType = text(source, KEYWORD_FIELDS.errorType);
  const message =
    text(source, TEXT_FIELDS.message) || text(source, TEXT_FIELDS.errorMessage) || "-";

  let line = columns.join("  ") + "  " + (errorType ? "[" + errorType + "] " : "") + message;

  const traceId = text(source, KEYWORD_FIELDS.traceId);
  if (traceId) line += "\n    trace.id: " + traceId;

  if (verbose) {
    const stack = text(source, STACK_TRACE);
    if (stack) line += "\n    " + stack.split("\n").join("\n    ");
  }

  return line;
}

export async function searchLogs(
  esClient: Client,
  indexPattern: string,
  filters: LogFilters & { limit?: number; verbose?: boolean }
): Promise<ToolResult> {
  const built = buildLogQuery(filters);
  if (!built.ok) return toolRefusal(built.reason);

  const verbose = filters.verbose ?? false;
  const requested = filters.limit ?? DEFAULT_LOG_HITS;
  const size = Math.min(Math.max(requested, 1), MAX_LOG_HITS);

  try {
    const response = await esClient.search<estypes.SearchResponse<LogSource>>({
      index: indexPattern,
      body: {
        query: built.query,
        size,
        // Newest first: a log question is about the present, and paging backwards
        // through time with `until` is what the next page means here.
        sort: [{ [TIMESTAMP]: { order: "desc" } }],
        // Only the fields the line is rendered from. On five hundred ECS events
        // the whole `_source` is the difference between an answer and an
        // exhausted budget, and the stack trace is the largest field of all —
        // so it is not even requested unless it will be printed.
        _source: verbose ? [...RENDERED_FIELDS, STACK_TRACE] : [...RENDERED_FIELDS],
      },
    });

    const { hits } = response.body;
    const total = typeof hits.total === "number" ? hits.total : hits.total?.value ?? 0;
    const returned = hits.hits.length;

    const summary = [
      textFragment(
        total + " matching events, showing the " + returned + " most recent.\n" +
          "Filters: " + built.described + "\n" +
          "Index pattern: " + indexPattern
      ),
    ];

    if (returned === 0) {
      summary.push(
        textFragment(
          "No events matched. Widen `since`, drop a filter, or check the vocabulary " +
            "with top_values on log.level or service.name — a keyword filter that does " +
            "not match the indexed spelling returns nothing rather than an error."
        )
      );
    }

    const oldest = hits.hits[returned - 1]?._source;
    const oldestTimestamp = oldest ? text(oldest, TIMESTAMP) : "";

    return budgeted({
      summary,
      detail: hits.hits.map((hit) => textFragment(renderLine(hit, verbose))),
      hint:
        total > returned && oldestTimestamp
          ? "Lower `limit`, narrow `since`, or ask for the previous page with until=" +
            oldestTimestamp
          : "Lower `limit` or narrow `since` to return fewer events.",
    });
  } catch (error) {
    return toolError("Log search failed", error);
  }
}
