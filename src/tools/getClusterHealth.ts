import { Client, estypes } from "@elastic/elasticsearch";
import { textFragment, toolError, type ToolResult } from "../toolResult.js";

export async function getClusterHealth(
  esClient: Client,
  includeIndices: boolean = false
): Promise<ToolResult> {
  try {
    const response = await esClient.cluster.health<
      estypes.ClusterHealthResponse
    >({
      level: includeIndices ? "indices" : "cluster",
    });

    const health = response.body;
    const content: ToolResult["content"] = [];

    // cluster-level overview
    content.push(
      textFragment(
        `Cluster Name: ${health.cluster_name}\nStatus: ${health.status}\nNodes: ${health.number_of_nodes}\nData Nodes: ${health.number_of_data_nodes}\nActive Shards: ${health.active_shards}\nActive Primary Shards: ${health.active_primary_shards}\nRelocating Shards: ${health.relocating_shards}\nInitializing Shards: ${health.initializing_shards}\nUnassigned Shards: ${health.unassigned_shards}\nPending Tasks: ${health.number_of_pending_tasks}\n`
      )
    );

    // index-level detail, only when asked for
    if (includeIndices && health.indices) {
      const indicesHealth = Object.entries(health.indices).map(
        ([indexName, indexHealth]) =>
          `Index: ${indexName}\n  Status: ${indexHealth.status}\n  Primary Shards: ${indexHealth.number_of_shards}\n  Replicas: ${indexHealth.number_of_replicas}\n  Active Shards: ${indexHealth.active_shards}\n  Active Primary Shards: ${indexHealth.active_primary_shards}\n  Unassigned Shards: ${indexHealth.unassigned_shards}`
      );

      if (indicesHealth.length > 0) {
        content.push(
          textFragment(`\nIndices Health Status:\n${indicesHealth.join("\n\n")}`)
        );
      }
    }

    return { content };
  } catch (error) {
    return toolError("Failed to get cluster health", error);
  }
}
