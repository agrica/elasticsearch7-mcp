import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Client } from "@elastic/elasticsearch";
import {
  explainAllocation,
  getIndexStats,
  listNodes,
  listShards,
} from "../tools/diagnostics.js";
import {
  getClusterSettings,
  getIndexSettings,
} from "../tools/settings.js";
import { listTasks } from "../tools/tasks.js";

/**
 * Read-only diagnostics, registered only when ES_ADMIN_TOOLS is set.
 *
 * They destroy nothing, so the flag is not about safety: it is about surface.
 * Every registered tool costs context on every session, and a deployment that
 * only searches should not pay for allocation explains it will never call.
 * Enable it wherever the agent is expected to diagnose — production included,
 * which is where these are most useful.
 */
export function registerAdminTools(server: McpServer, esClient: Client): void {
  // Why a shard will not allocate
  server.tool(
    "explain_allocation",
    "Explain why a shard is unassigned, with each node's allocator decision. This is what distinguishes a disk watermark from an allocation filter or a missing node.",
    {
      index: z
        .string()
        .optional()
        .describe("Index to explain. Omit to let Elasticsearch pick an unassigned shard."),

      shard: z
        .number()
        .optional()
        .describe("Shard number, defaults to 0. Requires index."),

      primary: z
        .boolean()
        .optional()
        .describe("Explain the primary (default) or a replica. Requires index."),
    },
    async ({ index, shard, primary }) => {
      return await explainAllocation(esClient, index, shard, primary);
    }
  );

  // Shard-level state, which index health cannot show
  server.tool(
    "list_shards",
    "Shard-level state: which copies are not STARTED and why, which node holds each, and its size. Index health only gives a colour.",
    {
      index: z
        .string()
        .optional()
        .describe("Index or wildcard. Omit for every shard on the cluster."),
    },
    async ({ index }) => {
      return await listShards(esClient, index);
    }
  );

  // Per-index counters
  server.tool(
    "get_index_stats",
    "Per-index counters: size, documents, segments, and indexing, search, merge and refresh activity. This is where a slow index shows itself.",
    {
      index: z
        .string()
        .trim()
        .min(1, "Index name is required")
        .describe("Concrete index name"),
    },
    async ({ index }) => {
      return await getIndexStats(esClient, index);
    }
  );

  // Node capacity
  server.tool(
    "list_nodes",
    "Node capacity: heap, RAM, CPU, load and disk. Disk pressure is the usual cause of unassigned shards and of an index turning read-only.",
    {},
    async () => {
      return await listNodes(esClient);
    }
  );

  // Index settings
  server.tool(
    "get_index_settings",
    "An index's settings. refresh_interval, number_of_replicas and read-only blocks explain most complaints about speed or refused writes.",
    {
      index: z
        .string()
        .trim()
        .min(1, "Index name is required")
        .describe("Concrete index name"),
    },
    async ({ index }) => {
      return await getIndexSettings(esClient, index);
    }
  );

  // Cluster settings that were overridden
  server.tool(
    "get_cluster_settings",
    "Cluster settings overridden at runtime, such as disabled allocation or a lowered disk watermark. Defaults are omitted.",
    {},
    async () => {
      return await getClusterSettings(esClient);
    }
  );

  // Everything the cluster is currently running
  server.tool(
    "list_tasks",
    "Every task the cluster is running, for finding a stuck reindex or a long search whose id nobody kept.",
    {
      actions: z
        .string()
        .optional()
        .describe("Action pattern, e.g. `*reindex*`. Omit for every task."),
    },
    async ({ actions }) => {
      return await listTasks(esClient, actions);
    }
  );
}
