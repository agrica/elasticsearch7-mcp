import { Client, estypes } from "@elastic/elasticsearch";
import { textFragment, toolError, toolRefusal, type ToolResult } from "../../toolResult.js";
import { budgeted } from "../../outputBudget.js";
import { KEYWORD_FIELDS, TEXT_FIELDS, TIMESTAMP } from "./fields.js";
import { buildLogQuery, type LogFilters } from "./logQuery.js";

/** How many distinct error types are reported, and how many services per type. */
export const DEFAULT_ERROR_GROUPS = 10;
export const MAX_ERROR_GROUPS = 50;
const SERVICES_PER_GROUP = 3;

/**
 * The label for events that carry no `error.type`.
 *
 * `terms` would otherwise skip those documents entirely, and that is the
 * dangerous silence: a vendor who logs failures with `log.level: ERROR` and a
 * `message` but no `error.*` fields would make this tool answer "no errors"
 * about a cluster full of them. Naming the bucket turns a wrong answer into a
 * visible one, and the sample message keeps it actionable.
 */
const NO_TYPE = "(no error.type)";

type Group = {
  key: string;
  doc_count: number;
  first?: { value_as_string?: string; value?: number | null };
  last?: { value_as_string?: string; value?: number | null };
  services?: { buckets?: { key: string; doc_count: number }[] };
  sample?: { hits?: { hits?: estypes.SearchHit<Record<string, unknown>>[] } };
};

function sampleMessage(group: Group): string {
  const source = group.sample?.hits?.hits?.[0]?._source ?? {};
  const value =
    source[TEXT_FIELDS.errorMessage] ??
    source[TEXT_FIELDS.message] ??
    (source["error"] as Record<string, unknown> | undefined)?.["message"] ??
    (source["message"] as unknown);

  if (typeof value !== "string") return "";
  // One line: a sample exists to recognise the error, not to read it. The full
  // text is one search_logs call away, with the type as a filter.
  const firstLine = value.split("\n")[0] ?? "";
  return firstLine.length > 200 ? firstLine.slice(0, 200) + "…" : firstLine;
}

export async function errorSummary(
  esClient: Client,
  indexPattern: string,
  filters: LogFilters & { groups?: number }
): Promise<ToolResult> {
  // No implicit level filter. Whether a failure is marked by `log.level` or by
  // the presence of `error.*` depends on the logging library, so imposing either
  // would decide the question this tool is asked to answer. The caller narrows
  // with `minLevel` when they know.
  const built = buildLogQuery(filters);
  if (!built.ok) return toolRefusal(built.reason);

  const size = Math.min(Math.max(filters.groups ?? DEFAULT_ERROR_GROUPS, 1), MAX_ERROR_GROUPS);

  try {
    const response = await esClient.search<estypes.SearchResponse<Record<string, unknown>>>({
      index: indexPattern,
      body: {
        query: built.query,
        size: 0,
        aggs: {
          error_types: {
            terms: { field: KEYWORD_FIELDS.errorType, size, missing: NO_TYPE },
            aggs: {
              first: { min: { field: TIMESTAMP } },
              last: { max: { field: TIMESTAMP } },
              services: {
                terms: { field: KEYWORD_FIELDS.service, size: SERVICES_PER_GROUP },
              },
              // One document per group, and only the fields the sample line
              // prints: a top_hits with the whole `_source` is how an
              // aggregation result grows to the size of a search result.
              sample: {
                top_hits: {
                  size: 1,
                  _source: [TEXT_FIELDS.message, TEXT_FIELDS.errorMessage],
                  sort: [{ [TIMESTAMP]: { order: "desc" } }],
                },
              },
            },
          },
        },
      },
    });

    const aggregation = response.body.aggregations?.["error_types"] as
      | { buckets?: Group[]; sum_other_doc_count?: number }
      | undefined;
    const groups = aggregation?.buckets ?? [];
    const others = aggregation?.sum_other_doc_count ?? 0;

    const matched = response.body.hits.total;
    const total = typeof matched === "number" ? matched : matched?.value ?? 0;

    let headline =
      total + " matching events in " + groups.length + " error type" +
      (groups.length === 1 ? "" : "s") + ".\nFilters: " + built.described;

    // The "no silent caps" rule: a truncated list of error types must say it is
    // truncated, or a model reads the tail as absent.
    if (others > 0) {
      headline +=
        "\n" + others + " events fall outside the top " + size +
        " types — raise `groups` to see them.";
    }

    const untyped = groups.find((group) => group.key === NO_TYPE);
    if (untyped !== undefined) {
      headline +=
        "\n" + untyped.doc_count + " of these carry no `error.type`, so they cannot be " +
        "grouped by type. That is a property of the mapping, not of the query: ECS " +
        "types `error.message` as text with no keyword sub-field, so there is nothing " +
        "else to group on. Filter with `query` on the message text instead.";
    }

    const details = groups.map((group) => {
      const services = (group.services?.buckets ?? [])
        .map((bucket) => bucket.key + " (" + bucket.doc_count + ")")
        .join(", ");
      const message = sampleMessage(group);

      return textFragment(
        group.key + "  ×" + group.doc_count + "\n" +
          "  " + (group.first?.value_as_string ?? "?") + " → " +
          (group.last?.value_as_string ?? "?") +
          (services ? "\n  services: " + services : "") +
          (message ? "\n  " + message : "")
      );
    });

    return budgeted({
      summary: [textFragment(headline)],
      detail: details,
      hint: "Lower `groups`, or narrow `since` and `service` to summarise less.",
    });
  } catch (error) {
    return toolError("Error summary failed", error);
  }
}
