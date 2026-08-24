import { Client, estypes } from "@elastic/elasticsearch";
import { textFragment, toolError, type ToolResult } from "../toolResult.js";

export async function createIndex(
  esClient: Client,
  index: string,
  settings?: estypes.IndicesIndexSettings,
  mappings?: estypes.MappingTypeMapping
): Promise<ToolResult> {
  try {
    const body: NonNullable<estypes.IndicesCreateRequest["body"]> = {};

    if (settings) {
      body.settings = settings;
    }

    if (mappings) {
      body.mappings = mappings;
    }

    const response = await esClient.indices.create<
      estypes.IndicesCreateResponse
    >({
      index,
      body,
    });

    if (response.body.acknowledged) {
      return {
        content: [
          textFragment(
            `Index "${index}" created successfully!\nShards: ${
              response.body.shards_acknowledged
                ? "acknowledged"
                : "awaiting acknowledgement"
            }`
          ),
        ],
      };
    }

    return {
      content: [
        textFragment(
          `Index "${index}" creation request was sent but not acknowledged. Check the cluster status.`
        ),
      ],
    };
  } catch (error) {
    return toolError("Create index failed", error);
  }
}
