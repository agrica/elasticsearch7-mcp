import { Client, estypes } from "@elastic/elasticsearch";
import { textFragment, toolError, type ToolResult } from "../toolResult.js";
import { budgeted, chunkedJson, fitRecords } from "../outputBudget.js";

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
  index?: string,
  verbose?: boolean
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

    const summary: ToolResult["content"] = [
      textFragment(
        `${shards.length} shards, ${unhealthy.length} not STARTED`
      ),
    ];

    // Lead with the broken ones: on a large cluster the started shards are
    // noise for whoever is diagnosing.
    if (unhealthy.length > 0) {
      summary.push(
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

    // The structured payload carries the same answer as the text, typed: the
    // not-started shards by default, every shard when the caller asked for
    // every shard. Letting it fill the budget with 2190 STARTED rows that
    // nobody asked for is how a 26-byte summary became a 32 KB result in the
    // first measurement of this change — the default has to stay a summary in
    // both channels, not just the readable one.
    const ordered = verbose
      ? [...unhealthy, ...shards.filter((shard) => shard.state === "STARTED")]
      : unhealthy;

    // The full dump used to be unconditional, and it is what let one call on a
    // 2190-shard cluster return 385 KB. The summary above is what a diagnosis
    // needs; the dump is now asked for.
    return budgeted({
      summary,
      detail: verbose ? chunkedJson(shards) : [],
      hint: index
        ? "Set verbose only when the per-shard fields are needed."
        : "Pass an index to look at one index's shards.",
      structured: (room) => {
        const { included, omitted } = fitRecords(ordered, room);
        return {
          ...(index ? { index } : {}),
          total: shards.length,
          notStarted: unhealthy.length,
          returned: included.length,
          omitted,
          shards: included,
        };
      },
    });
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

    // No verbose switch here: nodes number in the tens, not the thousands, so
    // this tool was never the hazard. The budget is a backstop, not a fix.
    return budgeted({
      summary: [
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
    });
  } catch (error) {
    return toolError("List nodes failed", error);
  }
}

/** Days below a day are zero, and hours above one are noise. */
function formatUptime(millis: number | undefined): string {
  if (millis === undefined) return "uptime ?";
  const hours = millis / 3_600_000;
  return hours >= 24 ? `uptime ${Math.floor(hours / 24)}d` : `uptime ${Math.floor(hours)}h`;
}

function gigabytes(value: number | undefined): string {
  return value === undefined ? "?" : `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function seconds(millis: number | undefined): string {
  return millis === undefined ? "?" : `${Math.round(millis / 1000)}s`;
}

/**
 * The three counters `_cat/nodes` cannot show: garbage collection, thread pool
 * queues and rejections, and tripped circuit breakers. One call, filtered to
 * three metrics — a bare `_nodes/stats` also returns `indices`, which is most of
 * the payload and answers none of these questions.
 *
 * Every counter here is cumulative since the node started, so the uptime is
 * printed beside them and the summary says so. A rejection count with nothing to
 * scale it against reads as "now" to a calling model, and "the cluster is
 * rejecting writes" is a very different answer from "it did, once, five weeks
 * ago".
 *
 * The filtering is asymmetric on purpose. Nodes are never dropped: they number
 * in the tens, and a node missing from the answer reads as a node that is fine.
 * Thread pools and breakers are dropped when idle: there are around twenty pools
 * per node, which is the dimension that would swamp the result.
 */
export async function getNodeStats(
  esClient: Client,
  verbose?: boolean
): Promise<ToolResult> {
  try {
    const response = await esClient.nodes.stats<estypes.NodesStatsResponse>({
      metric: "jvm,thread_pool,breaker",
    });

    const nodes = Object.values(response.body.nodes ?? {});
    const blocks: string[] = [];
    let busy = 0;
    let tripped = 0;

    for (const node of nodes) {
      const lines = [`${node.name ?? "?"} — ${formatUptime(node.jvm?.uptime_in_millis)}`];

      const mem = node.jvm?.mem;
      lines.push(
        `  heap ${mem?.heap_used_percent ?? "?"}% ` +
          `(${gigabytes(mem?.heap_used_in_bytes)} of ${gigabytes(mem?.heap_max_in_bytes)})`
      );

      // The collectors are iterated rather than named: "young" and "old" are
      // what a 7.x node running CMS or G1 reports today, but the names come
      // from the JVM, not from Elasticsearch.
      const collectors = Object.entries(node.jvm?.gc?.collectors ?? {});
      if (collectors.length > 0) {
        lines.push(
          `  GC ${collectors
            .map(([name, gc]) => `${name} ${gc.collection_count ?? "?"}/${seconds(gc.collection_time_in_millis)}`)
            .join(", ")}`
        );
      }

      // Selected by activity, not by a list of pool names. A whitelist of
      // write/search/bulk would leave a saturated force_merge or snapshot pool
      // invisible, and an unasked question does not fail — it returns nothing,
      // which a caller reads as "there is nothing".
      const pools = Object.entries(node.thread_pool ?? {}).filter(
        ([, pool]) =>
          (pool.queue ?? 0) > 0 || (pool.rejected ?? 0) > 0 || (pool.active ?? 0) > 0
      );
      if (pools.length > 0) busy += 1;
      for (const [name, pool] of pools) {
        lines.push(
          `  ${name}: active ${pool.active ?? 0}, queue ${pool.queue ?? 0}, rejected ${pool.rejected ?? 0}`
        );
      }

      const breakers = Object.entries(node.breakers ?? {}).filter(
        ([, breaker]) => (breaker.tripped ?? 0) > 0
      );
      if (breakers.length > 0) tripped += 1;
      for (const [name, breaker] of breakers) {
        lines.push(`  breaker ${name}: tripped ${breaker.tripped}`);
      }

      blocks.push(lines.join("\n"));
    }

    return budgeted({
      summary: [
        textFragment(
          `${nodes.length} nodes; ${busy} with queued or rejected work, ` +
            `${tripped} with a tripped breaker.\n` +
            `Counters are cumulative since each node's start — read them against the uptime on its line.`
        ),
        textFragment(blocks.join("\n")),
      ],
      detail: verbose ? chunkedJson(nodes) : [],
      hint: "Pass verbose for every thread pool and breaker, idle ones included.",
    });
  } catch (error) {
    return toolError("Get node stats failed", error);
  }
}
