import { Client, estypes } from "@elastic/elasticsearch";
import { textFragment, toolError, type ToolResult } from "../toolResult.js";

export async function getMappings(
  esClient: Client,
  index: string
): Promise<ToolResult> {
  try {
    const mappingResponse = await esClient.indices.getMapping<
      estypes.IndicesGetMappingResponse
    >({
      index,
    });

    return {
      content: [
        textFragment(`Index mapping: ${index}`),
        textFragment(
          `Index ${index} mapping: ${JSON.stringify(
            mappingResponse.body[index]?.mappings ?? {},
            null,
            2
          )}`
        ),
      ],
    };
  } catch (error) {
    return toolError("Failed to get mapping", error);
  }
}
