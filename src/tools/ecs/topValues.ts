import { Client, estypes } from "@elastic/elasticsearch";
import { textFragment, toolError, toolRefusal, type ToolResult } from "../../toolResult.js";
import { budgeted } from "../../outputBudget.js";
import { KEYWORD_FIELDS } from "./fields.js";
import { buildLogQuery, type LogFilters } from "./logQuery.js";

export const DEFAULT_TOP_VALUES = 10;
export const MAX_TOP_VALUES = 100;

/** The label for documents where the field is absent, for the `error_summary` reason. */
const MISSING = "(missing)";

/**
 * The ECS keyword fields this is most often asked about.
 *
 * A suggestion, not a permitted list: the cluster may carry keyword fields ECS
 * never defined, and refusing them would break a legitimate question to guard
 * against a mistake the cluster already reports. They are named in the failure
 * message instead.
 */
const SUGGESTED = Object.values(KEYWORD_FIELDS);

/**
 * Whether the cluster refused because the field is analysed text.
 *
 * This is the one mistake worth translating. Elasticsearch answers with a
 * 400 about fielddata, which says what it will not do but not what to do
 * instead — and the fix is nearly always the same field with `.keyword`
 * appended, or one of the ECS keyword fields.
 */
function isTextFieldRefusal(error: unknown): boolean {
  // Both places, because the reason lives in whichever the cluster filled in.
  // `ResponseError.message` is only the error *type* unless `root_cause` is an
  // array — verified in lib/errors.js:93-104 — and the sentence naming fielddata
  // sits in the root cause, so reading the message alone would miss it whenever
  // Elasticsearch reports the failure through `failed_shards` instead.
  const message = error instanceof Error ? error.message : String(error);
  const body = (error as { body?: unknown } | undefined)?.body;
  const haystack = message + (body === undefined ? "" : JSON.stringify(body));

  return (
    haystack.includes("Fielddata is disabled") ||
    haystack.includes("Text fields are not optimised") ||
    haystack.includes("fielddata=true")
  );
}

export async function topValues(
  esClient: Client,
  indexPattern: string,
  field: string,
  filters: LogFilters & { size?: number }
): Promise<ToolResult> {
  const built = buildLogQuery(filters);
  if (!built.ok) return toolRefusal(built.reason);

  const size = Math.min(Math.max(filters.size ?? DEFAULT_TOP_VALUES, 1), MAX_TOP_VALUES);

  try {
    const response = await esClient.search<estypes.SearchResponse<unknown>>({
      index: indexPattern,
      body: {
        query: built.query,
        size: 0,
        aggs: { values: { terms: { field, size, missing: MISSING } } },
      },
    });

    const aggregation = response.body.aggregations?.["values"] as
      | {
          buckets?: { key: string | number; doc_count: number }[];
          sum_other_doc_count?: number;
        }
      | undefined;
    const buckets = aggregation?.buckets ?? [];
    const others = aggregation?.sum_other_doc_count ?? 0;

    const matched = response.body.hits.total;
    const total = typeof matched === "number" ? matched : matched?.value ?? 0;

    let headline =
      buckets.length + " distinct values of " + field + " across " + total +
      " events.\nFilters: " + built.described;

    if (others > 0) {
      headline +=
        "\n" + others + " events hold a value outside the top " + size +
        " — raise `size` to see them.";
    }

    const widest = buckets.reduce((width, bucket) => Math.max(width, String(bucket.key).length), 0);

    const lines = buckets.map((bucket) => {
      const share = total > 0 ? Math.round((bucket.doc_count / total) * 100) : 0;
      return textFragment(
        String(bucket.key).padEnd(widest) + "  " + bucket.doc_count + "  (" + share + "%)"
      );
    });

    return budgeted({
      summary: [textFragment(headline)],
      detail: lines,
      hint: "Lower `size` to return fewer values.",
    });
  } catch (error) {
    if (isTextFieldRefusal(error)) {
      return toolRefusal(
        field + " is an analysed text field, so it cannot be aggregated. Try " +
          field + ".keyword if the mapping defines that sub-field, or one of the " +
          "ECS keyword fields: " + SUGGESTED.join(", ") + ". Use field_caps to see " +
          "which fields this index pattern reports as aggregatable."
      );
    }
    return toolError("Top values failed", error);
  }
}
