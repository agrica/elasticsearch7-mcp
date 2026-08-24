import { Client, estypes } from "@elastic/elasticsearch";
import {
  textFragment,
  toolError,
  toolRefusal,
  type ToolResult,
} from "../toolResult.js";

/**
 * These tools are registered only when ES_ALLOW_DESTRUCTIVE is set. The guard
 * below applies anyway: the environment variable says "deleting is allowed
 * here", not "delete whatever a pattern happens to match". A wildcard reaching
 * `indices.delete` is how one mistyped argument removes every log index, and
 * Elasticsearch will not ask for confirmation.
 */
function rejectBulkTarget(index: string): string | null {
  const target = index.trim();

  if (target.includes("*") || target.includes("?")) {
    return `Refusing to act on the pattern "${target}": name one concrete index. A wildcard here could match far more than intended.`;
  }
  if (target.includes(",")) {
    return `Refusing to act on a list of indices ("${target}"): call this once per index, so each one is a deliberate decision.`;
  }
  if (target === "_all" || target === "*") {
    return `Refusing to act on "${target}": that is every index on the cluster.`;
  }
  return null;
}

export async function deleteIndex(
  esClient: Client,
  index: string
): Promise<ToolResult> {
  try {
    const refusal = rejectBulkTarget(index);
    if (refusal) {
      return toolRefusal(refusal);
    }

    const response = await esClient.indices.delete<
      estypes.IndicesDeleteResponse
    >({ index });

    return {
      content: [
        textFragment(
          response.body.acknowledged
            ? `Index "${index}" deleted, with every document it held.`
            : `Delete request for "${index}" was not acknowledged. Check the cluster status.`
        ),
      ],
    };
  } catch (error) {
    return toolError("Delete index failed", error);
  }
}

export async function deleteDocument(
  esClient: Client,
  index: string,
  id: string
): Promise<ToolResult> {
  try {
    const refusal = rejectBulkTarget(index);
    if (refusal) {
      return toolRefusal(refusal);
    }

    // 404 is an answer here, not a failure: the document is already gone.
    const response = await esClient.delete<estypes.DeleteResponse>(
      { index, id, refresh: true },
      { ignore: [404] }
    );

    return {
      content: [
        textFragment(
          response.body.result === "not_found"
            ? `Document "${id}" does not exist in "${index}"; nothing was deleted.`
            : `Document "${id}" deleted from "${index}".`
        ),
      ],
    };
  } catch (error) {
    return toolError("Delete document failed", error);
  }
}

export async function deleteByQuery(
  esClient: Client,
  index: string,
  query: estypes.QueryDslQueryContainer
): Promise<ToolResult> {
  try {
    const refusal = rejectBulkTarget(index);
    if (refusal) {
      return toolRefusal(refusal);
    }

    // wait_for_completion: false, and this is a correctness fix rather than a
    // performance one. Run synchronously, the call blocked until Elasticsearch
    // finished; past the client's request timeout it reported
    // `Error: Request timed out` while the cluster carried on deleting. The
    // model was told a destructive operation had failed while it was
    // succeeding — and a model that retries then deletes against a moving
    // target. `reindex` already worked this way; the most dangerous tool did
    // not.
    const response = await esClient.deleteByQuery<{ task?: string }>({
      index,
      refresh: true,
      wait_for_completion: false,
      body: { query },
    });

    const task = response.body.task;

    return {
      content: [
        textFragment(
          task
            ? `Deletion started on "${index}" as task ${task}. It runs in the background: ` +
                `call get_task with this id to see progress, how many documents were ` +
                `deleted, and any failures. Documents are still being removed until it completes.`
            : `Deletion was accepted for "${index}" but Elasticsearch returned no task id, ` +
                `so its progress cannot be followed. Check the cluster's task list.`
        ),
      ],
    };
  } catch (error) {
    return toolError("Delete by query failed", error);
  }
}

// The synchronous branch's formatting — deleted / total / version conflicts /
// failures — is gone with it. Those counts now live in the task document, so
// `get_task` is where they are read, and keeping a second renderer here for a
// response shape this tool no longer receives would be dead code.
