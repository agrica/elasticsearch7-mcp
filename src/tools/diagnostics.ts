import { Client, estypes } from "@elastic/elasticsearch";
import { textFragment, toolError, type ToolResult } from "../toolResult.js";

/**
 * Why a shard is unassigned — the question a red or yellow index actually poses.
 * Elasticsearch answers with the decision of every allocator, which is the only
 * reliable way to tell a disk watermark from a filtered allocation or a missing
 * node.
 *
 * Called with no shard, Elasticsearch picks an arbitrary unassigned one, which
 * is usually what a caller diagnosing a cluster wants.
 */
export async function explainAllocation(
  esClient: Client,
  index?: string,
  shard?: number,
  primary?: boolean
): Promise<ToolResult> {
  try {
    const body =
      index !== undefined
        ? { index, shard: shard ?? 0, primary: primary ?? true }
        : undefined;

    const response = await esClient.cluster.allocationExplain<
      estypes.ClusterAllocationExplainResponse
    >({
      include_disk_info: true,
      ...(body ? { body } : {}),
    });

    const explanation = response.body;
    const content: ToolResult["content"] = [
      textFragment(
        `Shard ${explanation.index}[${explanation.shard}] ${
          explanation.primary ? "primary" : "replica"
        }: ${explanation.current_state}`
      ),
    ];

    if (explanation.unassigned_info) {
      content.push(
        textFragment(
          `Unassigned because: ${explanation.unassigned_info.reason}${
            explanation.unassigned_info.details
              ? `\nDetails: ${explanation.unassigned_info.details}`
              : ""
          }`
        )
      );
    }

    if (explanation.allocate_explanation) {
      content.push(textFragment(explanation.allocate_explanation));
    }

    // The per-node decisions name the actual blocker, e.g. a
    // "disk_threshold" or "filter" decider saying NO.
    if (explanation.node_allocation_decisions) {
      const decisions = explanation.node_allocation_decisions.map((decision) => {
        const blockers = (decision.deciders ?? [])
          .filter((decider) => decider.decision !== "YES")
          .map((decider) => `${decider.decider}: ${decider.explanation}`);
        return `${decision.node_name} -> ${decision.node_decision}${
          blockers.length > 0 ? `\n    ${blockers.join("\n    ")}` : ""
        }`;
      });
      content.push(textFragment(`Node decisions:\n  ${decisions.join("\n  ")}`));
    }

    return { content };
  } catch (error) {
    return toolError("Allocation explain failed", error);
  }
}

/**
 * Shard-level state, which index-level health cannot show: which copies are
 * UNASSIGNED and why, where each sits, and how big it is.
 */
export async function listShards(
  esClient: Client,
  index?: string
): Promise<ToolResult> {
  try {
    const response = await esClient.cat.shards<
      estypes.CatShardsShardsRecord[]
    >({
      format: "json",
      bytes: "b",
      ...(index ? { index } : {}),
      h: "index,shard,prirep,state,docs,store,node,unassigned.reason",
    });

    const shards = response.body;
    const unhealthy = shards.filter((shard) => shard.state !== "STARTED");

    const content: ToolResult["content"] = [
      textFragment(
        `${shards.length} shards, ${unhealthy.length} not STARTED`
      ),
    ];

    // Lead with the broken ones: on a large cluster the started shards are
    // noise for whoever is diagnosing.
    if (unhealthy.length > 0) {
      content.push(
        textFragment(
          `Not started:\n${unhealthy
            .map(
              (shard) =>
                `  ${shard.index}[${shard.shard}] ${shard.prirep} ${shard.state}` +
                `${shard["unassigned.reason"] ? ` — ${shard["unassigned.reason"]}` : ""}`
            )
            .join("\n")}`
        )
      );
    }

    content.push(textFragment(JSON.stringify(shards, null, 2)));

    return { content };
  } catch (error) {
    return toolError("List shards failed", error);
  }
}

/**
 * Per-index counters: size, document count, and the indexing, search, merge and
 * refresh activity that explains a slow index.
 */
export async function getIndexStats(
  esClient: Client,
  index: string
): Promise<ToolResult> {
  try {
    const response = await esClient.indices.stats<estypes.IndicesStatsResponse>({
      index,
    });

    const stats = response.body.indices?.[index]?.total;

    if (!stats) {
      return {
        content: [
          textFragment(
            `No statistics returned for "${index}". It may be an alias or a pattern rather than a concrete index.`
          ),
        ],
      };
    }

    return {
      content: [
        textFragment(
          `Index "${index}":\n` +
            `  Documents: ${stats.docs?.count ?? "?"} (${stats.docs?.deleted ?? "?"} deleted)\n` +
            `  Size: ${stats.store?.size_in_bytes ?? "?"} bytes\n` +
            `  Segments: ${stats.segments?.count ?? "?"}\n` +
            `  Indexing: ${stats.indexing?.index_total ?? "?"} ops, ${stats.indexing?.index_time_in_millis ?? "?"}ms, ${stats.indexing?.index_failed ?? "?"} failed\n` +
            `  Search: ${stats.search?.query_total ?? "?"} queries, ${stats.search?.query_time_in_millis ?? "?"}ms\n` +
            `  Merges: ${stats.merges?.total ?? "?"}, ${stats.merges?.total_time_in_millis ?? "?"}ms\n` +
            `  Refresh: ${stats.refresh?.total ?? "?"}, ${stats.refresh?.total_time_in_millis ?? "?"}ms`
        ),
      ],
    };
  } catch (error) {
    return toolError("Get index stats failed", error);
  }
}

/**
 * Node-level capacity: heap, disk and load. Disk pressure is the most common
 * cause of unassigned shards and of an index turning read-only, and neither is
 * visible from index-level health.
 */
export async function listNodes(esClient: Client): Promise<ToolResult> {
  try {
    const response = await esClient.cat.nodes<estypes.CatNodesNodesRecord[]>({
      format: "json",
      bytes: "b",
      h: "name,node.role,master,heap.percent,ram.percent,cpu,load_1m,disk.used_percent,disk.avail",
    });

    const nodes = response.body;

    return {
      content: [
        textFragment(`${nodes.length} nodes`),
        textFragment(
          nodes
            .map(
              (node) =>
                `${node.name} [${node["node.role"] ?? "?"}]${node.master === "*" ? " (master)" : ""}\n` +
                `  heap ${node["heap.percent"] ?? "?"}%  ram ${node["ram.percent"] ?? "?"}%  cpu ${node.cpu ?? "?"}%  load1m ${node.load_1m ?? "?"}\n` +
                `  disk used ${node["disk.used_percent"] ?? "?"}%  available ${node["disk.avail"] ?? "?"} bytes`
            )
            .join("\n")
        ),
      ],
    };
  } catch (error) {
    return toolError("List nodes failed", error);
  }
}
