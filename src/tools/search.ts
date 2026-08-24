import { Client, estypes } from "@elastic/elasticsearch";
import { textFragment, toolError, type ToolResult } from "../toolResult.js";

/** A search body: query DSL plus paging, sorting and highlighting. */
export type SearchBody = NonNullable<estypes.SearchRequest["body"]>;

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

    const content: ToolResult["content"] = [
      textFragment(
        `Total search results: ${total}, Displaying ${hits.hits.length} records starting from position ${from}`
      ),
    ];

    // Aggregation results are structured data, so they are returned as JSON
    // rather than prose. Without this the whole point of a `size: 0` + `aggs`
    // request — the standard aggregation pattern — was computed and discarded.
    if (aggregations && Object.keys(aggregations).length > 0) {
      content.push(
        textFragment(`Aggregations: ${JSON.stringify(aggregations, null, 2)}`)
      );
    }

    content.push(...contentFragments);

    return { content };
  } catch (error) {
    return toolError("Search failed", error);
  }
}
