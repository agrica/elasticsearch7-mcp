import { Client, estypes } from "@elastic/elasticsearch";
import { textFragment, toolError, type ToolResult } from "../toolResult.js";

/** One ndjson action line of a bulk index operation. */
type BulkIndexAction = { index: { _index: string; _id?: string } };

export async function bulk(
  esClient: Client,
  index: string,
  documents: Record<string, unknown>[],
  idField?: string
): Promise<ToolResult> {
  try {
    if (!documents || documents.length === 0) {
      return {
        content: [textFragment("Error: No documents provided for import")],
      };
    }

    // build the ndjson action/document pairs
    const operations: (BulkIndexAction | Record<string, unknown>)[] = [];

    for (const doc of documents) {
      const action: BulkIndexAction = { index: { _index: index } };

      // when an idField is given and present on the document, use it as the
      // document id — Elasticsearch ids are strings
      const id = idField ? doc[idField] : undefined;
      if (id !== undefined && id !== null && id !== "") {
        action.index._id = String(id);
      }

      operations.push(action);
      operations.push(doc);
    }

    // the 7.x client expects the ndjson operations under `body`
    const response = await esClient.bulk<estypes.BulkResponse>({
      refresh: true, // refresh at once so the documents are searchable
      body: operations,
    });

    const items = response.body.items;
    const failed = items.filter((item) => item.index?.error);
    const successCount = items.length - failed.length;

    const content: ToolResult["content"] = [
      textFragment(
        `Bulk import completed:\nTotal documents: ${documents.length}\nSuccessfully imported: ${successCount}\nFailed: ${failed.length}\nProcessing time: ${response.body.took}ms`
      ),
    ];

    // a per-document failure is not a tool failure: report each one
    if (failed.length > 0) {
      const errors = failed.map((item) => {
        const error = item.index?.error;
        const id = item.index?._id || "unknown";
        return `ID: ${id} - Error type: ${error?.type}, Reason: ${error?.reason}`;
      });

      content.push(textFragment(`Failed details:\n${errors.join("\n")}`));
    }

    return { content };
  } catch (error) {
    return toolError("Bulk import failed", error);
  }
}
