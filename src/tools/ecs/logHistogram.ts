import { Client, estypes } from "@elastic/elasticsearch";
import { textFragment, toolError, toolRefusal, type ToolResult } from "../../toolResult.js";
import { budgeted } from "../../outputBudget.js";
import { KEYWORD_FIELDS, TIMESTAMP } from "./fields.js";
import { buildLogQuery, DEFAULT_SINCE, type LogFilters } from "./logQuery.js";
import { suggestInterval } from "./timeRange.js";

/** What a histogram may be broken down by, and the field each names. */
export const BREAKDOWN_FIELDS = {
  level: KEYWORD_FIELDS.level,
  service: KEYWORD_FIELDS.service,
  host: KEYWORD_FIELDS.host,
  dataset: KEYWORD_FIELDS.dataset,
  errorType: KEYWORD_FIELDS.errorType,
} as const;

export type Breakdown = keyof typeof BREAKDOWN_FIELDS;

/** How many series a breakdown keeps per bucket. Enough to see the shape. */
const BREAKDOWN_SIZE = 5;

/**
 * Rows per detail fragment.
 *
 * One fragment per bucket is as wrong as one fragment for all of them, in the
 * other direction: the bucket count is unbounded — a 1m interval over 30 days is
 * 43 200 — and every fragment carries its own envelope on the wire, so the
 * result outgrew the budget by the count of its own fragments. Fifty matches
 * `chunkedJson` for the same reason it chose fifty: the trim stays fine-grained
 * without the fragment count becoming the payload.
 */
const ROWS_PER_FRAGMENT = 50;

type CountedBucket = { key: string; doc_count: number };

type TimeBucket = {
  key_as_string?: string;
  key: number | string;
  doc_count: number;
  breakdown?: { buckets?: CountedBucket[] };
};

export async function logHistogram(
  esClient: Client,
  indexPattern: string,
  filters: LogFilters & { interval?: string; by?: Breakdown }
): Promise<ToolResult> {
  const built = buildLogQuery(filters);
  if (!built.ok) return toolRefusal(built.reason);

  const since = filters.since ?? DEFAULT_SINCE;
  const given = (filters.interval ?? "").trim();
  const derived = given.length === 0;
  const interval = derived ? suggestInterval(since) : given;

  const histogram: Record<string, unknown> = {
    // `fixed_interval`, not the deprecated `interval`: 7.x accepts both and warns
    // about the second. Fixed rather than calendar because every width this tool
    // derives is a fixed duration, so branching on the unit would buy nothing.
    date_histogram: { field: TIMESTAMP, fixed_interval: interval, min_doc_count: 0 },
  };

  if (filters.by !== undefined) {
    histogram.aggs = {
      breakdown: { terms: { field: BREAKDOWN_FIELDS[filters.by], size: BREAKDOWN_SIZE } },
    };
  }

  try {
    const response = await esClient.search<estypes.SearchResponse<unknown>>({
      index: indexPattern,
      body: {
        query: built.query,
        // The buckets are the answer; the documents would only be paid for.
        size: 0,
        aggs: { over_time: histogram },
      },
    });

    const aggregation = response.body.aggregations?.["over_time"] as
      | { buckets?: TimeBucket[] }
      | undefined;
    const buckets = aggregation?.buckets ?? [];

    const total = buckets.reduce((sum, bucket) => sum + bucket.doc_count, 0);
    const peak = buckets.reduce<TimeBucket | undefined>(
      (best, bucket) =>
        best === undefined || bucket.doc_count > best.doc_count ? bucket : best,
      undefined
    );

    // Empty buckets are kept (`min_doc_count: 0`) because a gap is an answer:
    // "it stopped at 09:40" is usually what the caller is after, and a histogram
    // that skipped its zeros would read as continuous.
    const active = buckets.filter((bucket) => bucket.doc_count > 0);
    const first = active[0];
    const last = active[active.length - 1];

    const label = (bucket: TimeBucket): string =>
      bucket.key_as_string ?? String(bucket.key);

    let headline =
      total + " events over " + buckets.length + " buckets of " + interval +
      (derived ? " (derived from the window)" : "") + ".\n" +
      "Filters: " + built.described;

    if (peak !== undefined && peak.doc_count > 0) {
      headline += "\nPeak: " + peak.doc_count + " at " + label(peak);
    }

    headline +=
      first !== undefined && last !== undefined
        ? "\nFirst activity: " + label(first) + ", last: " + label(last)
        : "\nNo events in this window.";

    const rows = buckets.map((bucket) => {
      const breakdown = (bucket.breakdown?.buckets ?? [])
        .map((entry) => entry.key + "=" + entry.doc_count)
        .join(" ");
      return label(bucket) + "  " + bucket.doc_count + (breakdown ? "  " + breakdown : "");
    });

    const lines = [];
    for (let start = 0; start < rows.length; start += ROWS_PER_FRAGMENT) {
      lines.push(textFragment(rows.slice(start, start + ROWS_PER_FRAGMENT).join("\n")));
    }

    return budgeted({
      summary: [textFragment(headline)],
      detail: lines,
      hint: "Pass a wider `interval` or a shorter `since` to return fewer buckets.",
    });
  } catch (error) {
    return toolError("Log histogram failed", error);
  }
}
