import { Client, estypes } from "@elastic/elasticsearch";
import { textFragment, toolError, type ToolResult } from "../toolResult.js";

/**
 * How many documents match, without transferring any of them — the cheap answer
 * to "how big is this result set" before deciding whether to search.
 */
export async function count(
  esClient: Client,
  index: string,
  query?: estypes.QueryDslQueryContainer
): Promise<ToolResult> {
  try {
    const response = await esClient.count<estypes.CountResponse>({
      index,
      ...(query ? { body: { query } } : {}),
    });

    return {
      content: [
        textFragment(
          query
            ? `${response.body.count} documents match the query in "${index}".`
            : `${response.body.count} documents in "${index}".`
        ),
      ],
    };
  } catch (error) {
    return toolError("Count failed", error);
  }
}
