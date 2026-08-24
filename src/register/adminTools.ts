import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Client } from "@elastic/elasticsearch";
import { withCancellation } from "../cancellable.js";
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
  // Every handler reaches the cluster through this. The client it returns aborts
  // its in-flight request when the MCP client cancels the call — see
  // src/cancellable.ts for why that is bound to the client and not threaded
  // through each tool's arguments.
  const es = (extra: { signal: AbortSignal }) =>
    withCancellation(esClient, extra.signal);

  // Why a shard will not allocate
  server.registerTool(
    "explain_allocation",
    {
      title: "Explain shard allocation",
      description: "Explain why a shard is unassigned, with each node's allocator decision. This is what distinguishes a disk watermark from an allocation filter or a missing node.",
      inputSchema: {
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
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ index, shard, primary }, extra) => {
      return await explainAllocation(es(extra), index, shard, primary);
    }
  );

  // Shard-level state, which index health cannot show
  server.registerTool(
    "list_shards",
    {
      title: "List shards",
      description: "Shard-level state: which copies are not STARTED and why. Index health only gives a colour. Returns a summary; the per-shard detail needs verbose.",
      inputSchema: {
        index: z
          .string()
          .optional()
          .describe("Index or wildcard. Omit for every shard on the cluster."),

        verbose: z
          .boolean()
          .optional()
          .describe("Also return every shard as JSON. On a large cluster this is thousands of entries — pass an index with it."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ index, verbose }, extra) => {
      return await listShards(es(extra), index, verbose);
    }
  );

  // Per-index counters
  server.registerTool(
    "get_index_stats",
    {
      title: "Index statistics",
      description: "Per-index counters: size, documents, segments, and indexing, search, merge and refresh activity. This is where a slow index shows itself.",
      inputSchema: {
        index: z
          .string()
          .trim()
          .min(1, "Index name is required")
          .describe("Concrete index name"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ index }, extra) => {
      return await getIndexStats(es(extra), index);
    }
  );

  // Node capacity
  server.registerTool(
    "list_nodes",
    {
      title: "List nodes",
      description: "Node capacity: heap, RAM, CPU, load and disk. Disk pressure is the usual cause of unassigned shards and of an index turning read-only.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (_args, extra) => {
      return await listNodes(es(extra));
    }
  );

  // Index settings
  server.registerTool(
    "get_index_settings",
    {
      title: "Get index settings",
      description: "An index's settings. refresh_interval, number_of_replicas and read-only blocks explain most complaints about speed or refused writes.",
      inputSchema: {
        index: z
          .string()
          .trim()
          .min(1, "Index name is required")
          .describe("Concrete index name"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ index }, extra) => {
      return await getIndexSettings(es(extra), index);
    }
  );

  // Cluster settings that were overridden
  server.registerTool(
    "get_cluster_settings",
    {
      title: "Get cluster settings",
      description: "Cluster settings overridden at runtime, such as disabled allocation or a lowered disk watermark. Defaults are omitted.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (_args, extra) => {
      return await getClusterSettings(es(extra));
    }
  );

  // Everything the cluster is currently running
  server.registerTool(
    "list_tasks",
    {
      title: "List running tasks",
      description: "Every task the cluster is running, for finding a stuck reindex or a long search whose id nobody kept.",
      inputSchema: {
        actions: z
          .string()
          .optional()
          .describe("Action pattern, e.g. `*reindex*`. Omit for every task."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ actions }, extra) => {
      return await listTasks(es(extra), actions);
    }
  );
}
