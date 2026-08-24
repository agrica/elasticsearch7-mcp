import { Client, estypes } from "@elastic/elasticsearch";
import { textFragment, toolError, type ToolResult } from "../toolResult.js";
import { budgeted } from "../outputBudget.js";

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

export async function search(
  esClient: Client,
  index: string,
  queryBody: SearchBody
): Promise<ToolResult> {
  try {
    const mappingResponse = await esClient.indices.getMapping<
      estypes.IndicesGetMappingResponse
    >({
      index,
    });

    const indexMappings = mappingResponse.body[index]?.mappings ?? {};

    // The 7.x client expects the query DSL nested under `body`.
    const searchBody: SearchBody = { ...queryBody };

    const requestedSize = queryBody.size;
    const clamped =
      typeof requestedSize === "number" && requestedSize > MAX_SEARCH_SIZE;
    if (clamped) searchBody.size = MAX_SEARCH_SIZE;

    // Highlight every text field. dense_vector fields are deliberately left
    // out: Elasticsearch cannot highlight a vector.
    if (indexMappings.properties) {
      const textFields: Record<string, estypes.SearchHighlightField> = {};

      for (const [fieldName, fieldData] of Object.entries(
        indexMappings.properties
      )) {
        if ((fieldData as { type?: string }).type === "text") {
          textFields[fieldName] = {};
        }
      }

      searchBody.highlight = {
        fields: textFields,
        pre_tags: ["<em>"],
        post_tags: ["</em>"],
      };
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
