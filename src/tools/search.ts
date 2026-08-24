import { Client, estypes } from "@elastic/elasticsearch";
import { textFragment, toolError, type ToolResult } from "../toolResult.js";
import { budgeted } from "../outputBudget.js";
import { unwrapClient } from "../cancellable.js";
import { textFieldPaths } from "./mappingFields.js";

/** A search body: query DSL plus paging, sorting and highlighting. */
export type SearchBody = NonNullable<estypes.SearchRequest["body"]>;

/**
 * The largest `size` this tool will pass through.
 *
 * A model asking for 500 hits of log data was measured returning 127 716 bytes —
 * roughly 32 000 tokens — in one result. Clamping is better than letting the
 * byte budget trim the tail, because a clamp is visible in the reported count
 * and paging from there is exact, whereas a trimmed tail leaves the caller
 * guessing where it stopped.
 */
export const MAX_SEARCH_SIZE = 100;

/** What `highlight.fields` wants: a path per field, options per path. */
type HighlightFields = Record<string, estypes.SearchHighlightField>;

/**
 * The highlightable fields of an index, remembered for the life of the client.
 *
 * Every search used to pay a mapping request, whose answer changes about as
 * often as someone edits the mapping. Caching it trades one risk for the cost:
 * a field added mid-session is not highlighted until the process restarts. That
 * is the right trade, because the failure is a missing `<em>` on a new field —
 * the hits, the counts and the aggregations are unaffected. An invalidation
 * scheme would be more machinery than the mistake it prevents.
 *
 * Keyed on the client, so it is per *cluster* rather than per process, and
 * `unwrapClient` is what makes that key stable across calls — see
 * src/cancellable.ts.
 */
const highlightCache = new WeakMap<Client, Map<string, HighlightFields>>();

async function highlightFieldsFor(
  esClient: Client,
  index: string
): Promise<HighlightFields> {
  const cluster = unwrapClient(esClient);
  let perIndex = highlightCache.get(cluster);
  if (!perIndex) {
    perIndex = new Map();
    highlightCache.set(cluster, perIndex);
  }

  const cached = perIndex.get(index);
  if (cached) return cached;

  const mappingResponse = await esClient.indices.getMapping<
    estypes.IndicesGetMappingResponse
  >({ index });

  // `index` may be an alias or a wildcard, and then the response is keyed by
  // the concrete indices it resolved to, so `body[index]` is absent — which is
  // how the old lookup silently returned no fields for exactly the callers most
  // likely to want them. Take the union: a field that is `text` in any matched
  // index is worth highlighting.
  const fields: HighlightFields = {};
  for (const entry of Object.values(mappingResponse.body)) {
    for (const path of textFieldPaths(entry?.mappings?.properties)) {
      fields[path] = {};
    }
  }

  perIndex.set(index, fields);
  return fields;
}

export async function search(
  esClient: Client,
  index: string,
  queryBody: SearchBody
): Promise<ToolResult> {
  try {
    // The 7.x client expects the query DSL nested under `body`.
    const searchBody: SearchBody = { ...queryBody };

    const requestedSize = queryBody.size;
    const clamped =
      typeof requestedSize === "number" && requestedSize > MAX_SEARCH_SIZE;
    if (clamped) searchBody.size = MAX_SEARCH_SIZE;

    // A caller who brought their own highlight block keeps it, untouched. The
    // previous version overwrote it: a request carrying `pre_tags: ["**"]`
    // reached the cluster with `["<em>"]`, discarding an explicit instruction
    // without a word. Skipping the mapping request in that case is not an
    // optimisation, it is the same fact stated once: the caller has already
    // said what to highlight, so there is nothing to look up.
    if (searchBody.highlight === undefined) {
      const fields = await highlightFieldsFor(esClient, index);

      if (Object.keys(fields).length > 0) {
        searchBody.highlight = {
          fields,
          pre_tags: ["<em>"],
          post_tags: ["</em>"],
        };
      }
    }

    const result = await esClient.search<
      estypes.SearchResponse<Record<string, unknown>>
    >({
      index,
      body: searchBody,
    });

    const from = queryBody.from ?? 0;
    const { hits, aggregations } = result.body;
    const total =
      typeof hits.total === "number" ? hits.total : hits.total?.value ?? 0;

    const contentFragments = hits.hits.map((hit) => {
      const highlightedFields = hit.highlight ?? {};
      const sourceData = hit._source ?? {};

      let content = "";

      for (const [field, highlights] of Object.entries(highlightedFields)) {
        if (highlights && highlights.length > 0) {
          content += `${field} (Highlight): ${highlights.join(" ... ")}\n`;
        }
      }

      for (const [field, value] of Object.entries(sourceData)) {
        if (!(field in highlightedFields)) {
          content += `${field}: ${JSON.stringify(value)}\n`;
        }
      }

      return textFragment(content.trim());
    });

    const summary: ToolResult["content"] = [
      textFragment(
        `Total search results: ${total}, Displaying ${hits.hits.length} records starting from position ${from}` +
          (clamped
            ? `\n(size ${requestedSize} was clamped to ${MAX_SEARCH_SIZE}; page with from=${
                from + MAX_SEARCH_SIZE
              } for the next batch)`
            : "")
      ),
    ];

    // Aggregation results are structured data, so they are returned as JSON
    // rather than prose. Without this the whole point of a `size: 0` + `aggs`
    // request — the standard aggregation pattern — was computed and discarded.
    if (aggregations && Object.keys(aggregations).length > 0) {
      summary.push(
        textFragment(`Aggregations: ${JSON.stringify(aggregations, null, 2)}`)
      );
    }

    // Aggregations stay in the summary and the hits become detail. That order is
    // deliberate: an aggregation query asks for `size: 0`, so its answer is the
    // aggregation, and losing it to make room for documents nobody asked for
    // would discard the whole point of the call.
    return budgeted({
      summary,
      detail: contentFragments,
      hint: `Lower \`size\` or add \`_source\` filtering to return fewer fields per hit.`,
    });
  } catch (error) {
    return toolError("Search failed", error);
  }
}
