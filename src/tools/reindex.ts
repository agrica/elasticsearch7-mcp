import { Client, estypes } from "@elastic/elasticsearch";
import { textFragment, toolError, type ToolResult } from "../toolResult.js";

export async function reindex(
  esClient: Client,
  sourceIndex: string,
  destIndex: string,
  script?: estypes.Script,
  query?: estypes.QueryDslQueryContainer
): Promise<ToolResult> {
  try {
    // The 7.x client expects source/dest/script nested under `body`. Typing the
    // body means a misspelt key fails to compile rather than at the cluster.
    const body: NonNullable<estypes.ReindexRequest["body"]> = {
      source: {
        index: sourceIndex,
        ...(query ? { query } : {}),
      },
      dest: {
        index: destIndex,
      },
      ...(script ? { script } : {}),
    };

    const response = await esClient.reindex<estypes.ReindexResponse>({
      wait_for_completion: false, // async, so large indices do not time out
      body,
    });

    const taskId = response.body.task;

    return {
      content: [
        textFragment(`Reindex operation started. Task ID: ${taskId}`),
        textFragment(
          `Source index: ${sourceIndex} -> Destination index: ${destIndex}`
        ),
        textFragment(`Use Task API to monitor progress: GET _tasks/${taskId}`),
      ],
    };
  } catch (error) {
    return toolError("Reindex operation failed", error);
  }
}
