import { Client, estypes } from "@elastic/elasticsearch";
import {
  textFragment,
  toolError,
  toolRefusal,
  type ToolResult,
} from "../toolResult.js";
import { budgeted } from "../outputBudget.js";

/** One ndjson action line of a bulk index operation. */
type BulkIndexAction = { index: { _index: string; _id?: string } };

/**
 * The most documents one call will carry.
 *
 * The array was unbounded, and `refresh` was always on — the expensive option —
 * so a model deciding to import fifty thousand documents in a single call would
 * try, and the cluster would wear it. A bound with a message that says to chunk
 * is more useful than a timeout halfway through.
 */
export const MAX_BULK_DOCUMENTS = 1000;

export async function bulk(
  esClient: Client,
  index: string,
  documents: Record<string, unknown>[],
  idField?: string,
  refresh?: boolean
): Promise<ToolResult> {
  try {
    if (!documents || documents.length === 0) {
      return toolRefusal("No documents provided for import");
    }

    if (documents.length > MAX_BULK_DOCUMENTS) {
      return toolRefusal(
        `${documents.length} documents in one call exceeds the limit of ${MAX_BULK_DOCUMENTS}. ` +
          `Send them in batches of at most ${MAX_BULK_DOCUMENTS}; each batch is indexed independently.`
      );
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

    // Refresh defaults on, which is right for the small import a model makes
    // interactively — the documents are searchable straight away, so it can
    // verify its own work. It is wrong for a bulk load, where forcing a refresh
    // per batch is the expensive part, hence the switch.
    const refreshRequested = refresh ?? true;

    // the 7.x client expects the ndjson operations under `body`
    const response = await esClient.bulk<estypes.BulkResponse>({
      refresh: refreshRequested,
      body: operations,
    });

    const items = response.body.items;
    const failed = items.filter((item) => item.index?.error);
    const successCount = items.length - failed.length;

    const summary: ToolResult["content"] = [
      textFragment(
        `Bulk import completed:\nTotal documents: ${documents.length}\nSuccessfully imported: ${successCount}\nFailed: ${failed.length}\nProcessing time: ${response.body.took}ms` +
          (refreshRequested
            ? ""
            : "\nRefresh was skipped, so the documents are not searchable yet.")
      ),
    ];

    // a per-document failure is not a tool failure: report each one
    const detail: ToolResult["content"] = [];
    if (failed.length > 0) {
      const errors = failed.map((item) => {
        const error = item.index?.error;
        const id = item.index?._id || "unknown";
        return `ID: ${id} - Error type: ${error?.type}, Reason: ${error?.reason}`;
      });

      detail.push(textFragment(`Failed details:\n${errors.join("\n")}`));
    }

    // The counts are in the summary and survive; the per-document reasons are
    // detail. A thousand identical mapping errors do not need a thousand lines
    // to be acted on.
    return budgeted({
      summary,
      detail,
      hint: "Send a smaller batch to see every failure reason.",
    });
  } catch (error) {
    return toolError("Bulk import failed", error);
  }
}
