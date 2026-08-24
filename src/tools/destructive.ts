import { Client, estypes } from "@elastic/elasticsearch";
import { textFragment, toolError, type ToolResult } from "../toolResult.js";

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
      return { content: [textFragment(`Error: ${refusal}`)] };
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
      return { content: [textFragment(`Error: ${refusal}`)] };
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
      return { content: [textFragment(`Error: ${refusal}`)] };
    }

    const response = await esClient.deleteByQuery<
      estypes.DeleteByQueryResponse
    >({
      index,
      refresh: true,
      body: { query },
    });

    const { deleted, total, version_conflicts, failures } = response.body;
    const content: ToolResult["content"] = [
      textFragment(
        `Deleted ${deleted ?? 0} of ${total ?? 0} matching documents in "${index}".`
      ),
    ];

    if (version_conflicts) {
      content.push(
        textFragment(
          `${version_conflicts} version conflicts: those documents changed while the delete ran and were left alone.`
        )
      );
    }

    if (failures && failures.length > 0) {
      content.push(
        textFragment(`Failures: ${JSON.stringify(failures, null, 2)}`)
      );
    }

    return { content };
  } catch (error) {
    return toolError("Delete by query failed", error);
  }
}
