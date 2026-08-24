import { Client, estypes } from "@elastic/elasticsearch";
import { textFragment, toolError, type ToolResult } from "../toolResult.js";

export async function getDocument(
  esClient: Client,
  index: string,
  id: string
): Promise<ToolResult> {
  try {
    // A missing document is an answer, not a failure: 404 is tolerated so the
    // caller reads "not found" instead of an `Error:` fragment.
    const response = await esClient.get<
      estypes.GetGetResult<Record<string, unknown>>
    >({ index, id }, { ignore: [404] });

    const document = response.body;

    if (!document.found) {
      return {
        content: [textFragment(`Document "${id}" not found in "${index}".`)],
      };
    }

    return {
      content: [
        textFragment(
          `Document "${id}" in "${index}" (version ${document._version ?? "unknown"})`
        ),
        textFragment(JSON.stringify(document._source ?? {}, null, 2)),
      ],
    };
  } catch (error) {
    return toolError("Get document failed", error);
  }
}
