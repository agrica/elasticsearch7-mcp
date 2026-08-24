import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClientSource } from "../auth/clientSource.js";
import { clientRunner } from "./clientRunner.js";
import { requiredText } from "./schemas.js";
import { searchLogs } from "../tools/ecs/searchLogs.js";
import { logHistogram, type Breakdown } from "../tools/ecs/logHistogram.js";
import { errorSummary } from "../tools/ecs/errorSummary.js";
import { topValues } from "../tools/ecs/topValues.js";

/**
 * The breakdowns `log_histogram` offers, spelled out rather than derived from
 * the field map's keys.
 *
 * Derived, the enum types as `string`, which forced a cast at the call site —
 * and a cast there would hide the enum drifting from the fields it names. Named
 * here, both directions are compile errors: a typo makes the value unassignable
 * to `Breakdown`, and a breakdown field added without a choice for it fails the
 * assertion below.
 */
const BREAKDOWN_CHOICES = ["level", "service", "host", "dataset", "errorType"] as const;

type Assert<T extends true> = T;
export type BreakdownChoicesAreComplete = Assert<
  Breakdown extends (typeof BREAKDOWN_CHOICES)[number] ? true : false
>;

/**
 * The filters all four tools share.
 *
 * Declared once, because four copies of ten descriptions is where they start
 * disagreeing — and these descriptions are the calling model's only
 * documentation. The wording spends its words on what a caller gets wrong
 * unprompted: that the keyword filters are exact, and that `since` takes a bare
 * duration.
 */
const LOG_FILTERS = {
  since: z
    .string()
    .optional()
    .describe('How far back, as a bare duration ago: "15m", "2h", "7d". Also accepts date math ("now-1d/d") or an absolute date. Defaults to 15m.'),

  until: z
    .string()
    .optional()
    .describe("End of the window, same forms as since. Omit for now; this is how you page backwards."),

  service: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe("service.name, exactly as indexed. A misspelling returns nothing rather than an error — use top_values to see the real values."),

  levels: z
    .array(z.string())
    .optional()
    .describe('Exact log.level values. Case is ignored, and "error" also matches SEVERE.'),

  minLevel: z
    .string()
    .optional()
    .describe("This severity and above: TRACE, DEBUG, INFO, WARN, ERROR, FATAL."),

  query: z
    .string()
    .optional()
    .describe("Free text, matched against message and error.message."),

  host: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe("host.name"),

  logger: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe("log.logger"),

  dataset: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe("event.dataset"),

  traceId: z
    .string()
    .optional()
    .describe("trace.id — one distributed request."),
} as const;

/**
 * The ECS log tools, registered only when ES_ECS_TOOLS is set.
 *
 * They read one index pattern — `ES_ECS_INDEX_PATTERN`, which is why the
 * pattern is a parameter here and not a tool argument: the operator decides
 * which indices this server may search, and the calling model cannot widen it.
 *
 * Read-only, so the flag is about surface rather than safety, as with the
 * diagnostics. What it buys is real: a cluster whose logs are not in ECS would
 * otherwise pay for four tool schemas that can only return nothing.
 */
export function registerEcsTools(
  server: McpServer,
  source: ClientSource,
  indexPattern: string
): void {
  const call = clientRunner(source);

  // What happened
  server.registerTool(
    "search_logs",
    {
      title: "Search ECS logs",
      description:
        "Recent log events from the configured ECS index pattern, newest first, one line each. Filters are named rather than a query DSL, and keyword filters match exactly. Prefer this over search for log questions: it asks for only the fields it prints, where search returns whole documents.",
      inputSchema: {
        ...LOG_FILTERS,
        limit: z
          .number()
          .optional()
          .describe("Events to return, default 20, maximum 100. Page backwards with until, not from."),
        verbose: z
          .boolean()
          .optional()
          .describe("Also print error.stack_trace. Off by default, and then the field is not even requested — it is the largest in the document."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ limit, verbose, ...filters }, extra) =>
      call(extra, (es) => searchLogs(es, indexPattern, { ...filters, limit, verbose }))
  );

  // When it started, and whether it is still going
  server.registerTool(
    "log_histogram",
    {
      title: "Log volume over time",
      description:
        "Event counts per time bucket, to see when something started, peaked, or stopped. The bucket width is derived from the window unless given. Empty buckets are kept, because a gap is part of the answer.",
      inputSchema: {
        ...LOG_FILTERS,
        interval: z
          .string()
          .optional()
          .describe("Bucket width as a fixed duration: 30s, 5m, 1h, 1d. Derived from the window when omitted."),
        by: z
          .enum(BREAKDOWN_CHOICES)
          .optional()
          .describe("Break each bucket down by this field, keeping its top 5 values."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ interval, by, ...filters }, extra) =>
      call(extra, (es) => logHistogram(es, indexPattern, { ...filters, interval, by }))
  );

  // What is broken
  server.registerTool(
    "error_summary",
    {
      title: "Summarise errors",
      description:
        "Errors grouped by error.type, with a count, first and last occurrence, the services affected and a sample message. Grouping is by type because ECS maps error.message as text with no keyword sub-field, so it cannot be aggregated; events carrying no error.type get their own reported bucket rather than being dropped.",
      inputSchema: {
        ...LOG_FILTERS,
        groups: z
          .number()
          .optional()
          .describe("Distinct error types to report, default 10, maximum 50."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ groups, ...filters }, extra) =>
      call(extra, (es) => errorSummary(es, indexPattern, { ...filters, groups }))
  );

  // Who, where, what
  server.registerTool(
    "top_values",
    {
      title: "Top values of a field",
      description:
        "The most frequent values of one field over the window, with counts and shares. Use it to learn what a cluster actually indexes — the real spellings of log.level, which services exist — before filtering on a guess. The field must be aggregatable, so a keyword.",
      inputSchema: {
        field: requiredText(
          "Field to count values of, e.g. log.level, service.name, error.type. Must be aggregatable; field_caps says which are.",
          "Field name is required"
        ),
        ...LOG_FILTERS,
        size: z
          .number()
          .optional()
          .describe("Distinct values to return, default 10, maximum 100."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ field, size, ...filters }, extra) =>
      call(extra, (es) => topValues(es, indexPattern, field, { ...filters, size }))
  );
}
