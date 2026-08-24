import { Client, estypes } from "@elastic/elasticsearch";
import { textFragment, toolError, type ToolResult } from "../toolResult.js";

/**
 * List Elasticsearch indices, optionally filtered.
 *
 * `pattern` reaches the cat API as an Elasticsearch wildcard (`log-*`), not a
 * regex, despite what the tool description says.
 */
export async function listIndices(
  esClient: Client,
  pattern?: string
): Promise<ToolResult> {
  try {
    const response = await esClient.cat.indices<
      estypes.CatIndicesIndicesRecord[]
    >({
      format: "json",
      index: pattern || "*",
      // Sizes in bytes, so a caller can compare them instead of parsing "4.7gb".
      bytes: "b",
    });

    const indicesInfo = response.body.map((index) => ({
      index: index.index,
      health: index.health,
      status: index.status,
      // The cat API returns dotted keys; the camelCase aliases exist only in
      // the type definitions and are undefined at runtime.
      docsCount: index["docs.count"],
      storeSizeBytes: index["store.size"],
    }));

    return {
      content: [
        textFragment(`Found ${indicesInfo.length} indices`),
        textFragment(JSON.stringify(indicesInfo, null, 2)),
      ],
    };
  } catch (error) {
    return toolError("Failed to list indices", error);
  }
}
