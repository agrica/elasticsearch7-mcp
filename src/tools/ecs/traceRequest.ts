import { Client, estypes } from "@elastic/elasticsearch";
import { textFragment, toolError, toolRefusal, type ToolResult } from "../../toolResult.js";
import { budgeted } from "../../outputBudget.js";
import {
  CORRELATION_FIELDS,
  KEYWORD_FIELDS,
  STACK_TRACE,
  TEXT_FIELDS,
  TIMESTAMP,
  minLevelTerms,
} from "./fields.js";
import { buildLogQuery, type LogFilters } from "./logQuery.js";

/**
 * How many log lines the timeline holds, and how many it holds by default.
 *
 * Both are higher than `search_logs`, and deliberately so: there the caller asks
 * for a page of recent events and twenty answer the question, while here they
 * asked for *one* request and a page of it is not an answer. A trace cut in the
 * middle hides exactly the hop that failed, and the caller has no way to tell a
 * short request from a truncated one. Measured on a real three-service request:
 * 395 lines, because a Feign-style HTTP logger writes one line per header.
 *
 * The byte budget still applies on top, which is why the hop table and the
 * errors are summary fragments — they survive a trim, the timeline is what goes.
 */
export const MAX_TRACE_HITS = 1000;
export const DEFAULT_TRACE_HITS = 200;

/** How many distinct services, environments and hosts a hop reports. */
const MAX_HOPS = 25;
const VALUES_PER_HOP = 3;

/** How many failing events are printed before the rest are only counted. */
const MAX_FAILURES_SHOWN = 10;

/**
 * The terms that count as a failure, taken from the shared ladder rather than
 * spelled out here.
 *
 * `minLevelTerms("error")` is error and above, in every alias and case the
 * ladder knows — so `SEVERE` from java.util.logging and `crit` from a syslog
 * bridge are counted, which a hand-written list of ERROR and FATAL would drop.
 */
const FAILURE_TERMS: readonly string[] = minLevelTerms("error") ?? ["ERROR"];

/**
 * The default window, wider than the one the other tools share.
 *
 * A caller reaches this tool holding an identifier they read off an error that
 * `error_summary` or `search_logs` already showed them, which may be hours old —
 * so the 15 minutes that suit "what is happening now" would answer "no such
 * request" for the normal case. A correlation identifier is selective enough
 * that widening it costs the cluster almost nothing.
 */
export const DEFAULT_TRACE_SINCE = "24h";

type TraceSource = Record<string, unknown>;

/** `a.b.c` out of a `_source` that may be nested or flattened. */
function read(source: TraceSource, path: string): unknown {
  if (path in source) return source[path];

  let cursor: unknown = source;
  for (const segment of path.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function text(source: TraceSource, path: string): string {
  const value = read(source, path);
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** The fields a trace line is rendered from. */
const TRACE_FIELDS: readonly string[] = [
  TIMESTAMP,
  TEXT_FIELDS.message,
  TEXT_FIELDS.errorMessage,
  KEYWORD_FIELDS.level,
  KEYWORD_FIELDS.logger,
  KEYWORD_FIELDS.service,
  KEYWORD_FIELDS.environment,
  KEYWORD_FIELDS.host,
  KEYWORD_FIELDS.errorType,
  ...CORRELATION_FIELDS,
];

type Hop = {
  key: string;
  doc_count: number;
  first?: { value_as_string?: string };
  last?: { value_as_string?: string };
  env?: { buckets?: { key: string; doc_count: number }[] };
  host?: { buckets?: { key: string; doc_count: number }[] };
};

type Bucket = { key: string; doc_count: number };

function bucketKeys(agg: { buckets?: Bucket[] } | undefined): string[] {
  return (agg?.buckets ?? []).map((bucket) => bucket.key);
}

/**
 * One hop of the chain, one line.
 *
 * The environment is printed next to the service rather than left out, because
 * on a cluster that collects several environments a service name alone does not
 * say which deployment answered — and a trace is exactly where that ambiguity
 * would send someone reading the wrong logs.
 */
function renderHop(hop: Hop, index: number): string {
  const envs = bucketKeys(hop.env);
  const hosts = bucketKeys(hop.host);
  const name = hop.key + (envs.length > 0 ? "/" + envs.join("|") : "");

  return (
    "  " +
    String(index + 1) +
    ". " +
    name +
    (hosts.length > 0 ? "  on " + hosts.join("|") : "") +
    "  " +
    hop.doc_count +
    " events  " +
    (hop.first?.value_as_string ?? "?") +
    " → " +
    (hop.last?.value_as_string ?? "?")
  );
}

/** One log line of the timeline: when, how bad, who, which logger, what. */
function renderLine(hit: estypes.SearchHit<TraceSource>, verbose: boolean): string {
  const source = hit._source ?? {};
  const service = text(source, KEYWORD_FIELDS.service) || "-";
  const env = text(source, KEYWORD_FIELDS.environment);
  const errorType = text(source, KEYWORD_FIELDS.errorType);
  const message =
    text(source, TEXT_FIELDS.message) || text(source, TEXT_FIELDS.errorMessage) || "-";

  let line =
    [
      text(source, TIMESTAMP) || "-",
      text(source, KEYWORD_FIELDS.level) || "-",
      service + (env ? "/" + env : ""),
      text(source, KEYWORD_FIELDS.logger) || "-",
    ].join("  ") +
    "  " +
    (errorType ? "[" + errorType + "] " : "") +
    message;

  if (verbose) {
    const stack = text(source, STACK_TRACE);
    if (stack) line += "\n    " + stack.split("\n").join("\n    ");
  }

  return line;
}

/**
 * Every log event carrying one correlation identifier, across every service that
 * handled it, oldest first.
 *
 * This is the tool for "where did this go wrong", as opposed to "what is
 * broken": the other tools in this module aggregate across requests, and none of
 * them can say that the failure a caller is looking at came from a call two
 * services further down. The identifier is what makes that reachable, so the
 * tool exists to be pointed at one.
 *
 * Three things shape the output. It reads oldest-first, because a chain is
 * followed forwards while a log tail is read backwards. The hop table comes from
 * aggregations rather than from the returned events, so it stays exact when the
 * timeline is capped or trimmed. And the errors are lifted into their own
 * fragment, because they are the answer and the budget must not be able to drop
 * them.
 */
export async function traceRequest(
  esClient: Client,
  indexPattern: string,
  id: string,
  filters: LogFilters & { limit?: number; verbose?: boolean } = {}
): Promise<ToolResult> {
  const identifier = id?.trim() ?? "";
  if (identifier.length === 0) {
    return toolRefusal(
      "A correlation identifier is required. It is the value of trace.id or " +
        "http.request.id on an event — search_logs and error_summary print it, " +
        "and top_values on either field shows which one this cluster populates."
    );
  }

  const built = buildLogQuery({ ...filters, since: filters.since ?? DEFAULT_TRACE_SINCE });
  if (!built.ok) return toolRefusal(built.reason);

  const verbose = filters.verbose ?? false;
  const requested = filters.limit ?? DEFAULT_TRACE_HITS;
  const size = Math.min(Math.max(requested, 1), MAX_TRACE_HITS);

  // The identifier goes in `should`, not `filter`: either correlation field
  // carrying it is the same request. `minimum_should_match` is what keeps that a
  // requirement rather than a preference — without it the clause would only
  // influence scoring, and the tool would return the whole window.
  const query: estypes.QueryDslQueryContainer = {
    bool: {
      ...built.query.bool,
      should: CORRELATION_FIELDS.map((field) => ({ term: { [field]: identifier } })),
      minimum_should_match: 1,
    },
  };

  try {
    const response = await esClient.search<estypes.SearchResponse<TraceSource>>({
      index: indexPattern,
      body: {
        query,
        size,
        // Oldest first: the answer is the order things happened in.
        sort: [{ [TIMESTAMP]: { order: "asc" } }],
        _source: verbose ? [...TRACE_FIELDS, STACK_TRACE] : [...TRACE_FIELDS],
        aggs: {
          // Ordered by when each service first appears, which is the order the
          // request travelled in. `terms` ordered by a sub-aggregation is
          // approximate across shards in general; here the whole trace is a
          // handful of services, so every one of them is in the response and the
          // ordering is over the complete set.
          hops: {
            terms: {
              field: KEYWORD_FIELDS.service,
              size: MAX_HOPS,
              order: { first: "asc" },
            },
            aggs: {
              first: { min: { field: TIMESTAMP } },
              last: { max: { field: TIMESTAMP } },
              env: { terms: { field: KEYWORD_FIELDS.environment, size: VALUES_PER_HOP } },
              host: { terms: { field: KEYWORD_FIELDS.host, size: VALUES_PER_HOP } },
            },
          },
          levels: { terms: { field: KEYWORD_FIELDS.level, size: 10 } },
          // The failures come from an aggregation, not from the returned hits.
          // Derived from the hits they would be bounded by `limit`, and on a
          // real 385-event trace the one ERROR sat past the 200th line — so the
          // tool answered with a chain and no reason it broke, while its own
          // description promised the opposite. An aggregation sees the whole
          // request whatever the timeline is capped at.
          failures: {
            filter: { terms: { [KEYWORD_FIELDS.level]: [...FAILURE_TERMS] } },
            aggs: {
              events: {
                top_hits: {
                  size: MAX_FAILURES_SHOWN,
                  sort: [{ [TIMESTAMP]: { order: "asc" } }],
                  _source: [...TRACE_FIELDS],
                },
              },
            },
          },
        },
      },
    });

    const { hits, aggregations } = response.body;
    const total = typeof hits.total === "number" ? hits.total : hits.total?.value ?? 0;
    const returned = hits.hits.length;

    if (total === 0) {
      return {
        content: [
          textFragment(
            'No events carry the identifier "' +
              identifier +
              '".\n' +
              "Filters: " +
              built.described +
              "\n" +
              "Index pattern: " +
              indexPattern +
              "\n\n" +
              "Checked both " +
              CORRELATION_FIELDS.join(" and ") +
              ". Widen `since` — a request is only as old as its window — or run " +
              "top_values on those two fields to see which one this cluster " +
              "populates, and whether it is populated at all."
          ),
        ],
      };
    }

    const hops = ((aggregations?.["hops"] as { buckets?: Hop[] } | undefined)?.buckets ?? []);
    const levels = ((aggregations?.["levels"] as { buckets?: Bucket[] } | undefined)?.buckets ?? []);

    const first = hits.hits[0]?._source;
    const last = hits.hits[returned - 1]?._source;
    const startedAt = first ? text(first, TIMESTAMP) : "";
    const endedAt = last ? text(last, TIMESTAMP) : "";
    const elapsedMs =
      startedAt && endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : Number.NaN;

    const summary = [
      textFragment(
        total +
          " events for " +
          identifier +
          " across " +
          hops.length +
          (hops.length === 1 ? " service" : " services") +
          (returned < total ? ", timeline showing the first " + returned : "") +
          ".\n" +
          "Filters: " +
          built.described +
          "\n" +
          (Number.isFinite(elapsedMs)
            ? "Span: " + startedAt + " → " + endedAt + "  (" + elapsedMs + " ms)\n"
            : "") +
          "Levels: " +
          (levels.length > 0
            ? levels.map((bucket) => bucket.key + " " + bucket.doc_count).join(", ")
            : "none indexed")
      ),
    ];

    if (hops.length > 0) {
      summary.push(
        textFragment("Chain, in the order each service first appears:\n" + hops.map(renderHop).join("\n"))
      );
    }

    // The failures, lifted out of the timeline. A trace is read to find these,
    // so they are a summary fragment: `detail` is what the byte budget trims,
    // and a caller left with a chain and no reason it broke has not been
    // answered. The count is the aggregation's, so it covers the whole request
    // even when only the first `MAX_FAILURES_SHOWN` are printed.
    const failing = aggregations?.["failures"] as
      | { doc_count?: number; events?: { hits?: { hits?: estypes.SearchHit<TraceSource>[] } } }
      | undefined;
    const failureCount = failing?.doc_count ?? 0;
    const failureHits = failing?.events?.hits?.hits ?? [];

    if (failureCount > 0) {
      const shown = failureHits.map((hit) => "  " + renderLine(hit, false)).join("\n");
      summary.push(
        textFragment(
          failureCount +
            (failureCount === 1 ? " failing event" : " failing events") +
            (failureCount > failureHits.length
              ? ", first " + failureHits.length + ":\n"
              : ":\n") +
            shown
        )
      );
    }

    return budgeted({
      summary,
      detail: hits.hits.map((hit) => textFragment(renderLine(hit, verbose))),
      hint:
        total > returned
          ? "The timeline is capped at `limit`; the chain and the failing events above " +
            "cover the whole request. Narrow with `service` or `minLevel` to read fewer lines."
          : "Narrow with `service` or `minLevel` to read fewer lines of this request.",
    });
  } catch (error) {
    return toolError("Request trace failed", error);
  }
}
