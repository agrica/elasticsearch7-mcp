import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Client } from "@elastic/elasticsearch";
import { withCancellation } from "../cancellable.js";
import {
  deleteByQuery,
  deleteDocument,
  deleteIndex,
} from "../tools/destructive.js";
import { deleteIndexTemplate } from "../tools/createIndexTemplate.js";

/**
 * Tools that destroy data or configuration. Registered only when
 * ES_ALLOW_DESTRUCTIVE is set, so a production deployment simply does not
 * expose them — a model cannot call a tool it never sees.
 *
 * `delete_index_template` lives here rather than beside the other template
 * tools: leaving a delete reachable in production while `delete_index` is gated
 * would be incoherent.
 */
export function registerDestructiveTools(
  server: McpServer,
  esClient: Client
): void {
  // Every handler reaches the cluster through this. The client it returns aborts
  // its in-flight request when the MCP client cancels the call — see
  // src/cancellable.ts for why that is bound to the client and not threaded
  // through each tool's arguments.
  const es = (extra: { signal: AbortSignal }) =>
    withCancellation(esClient, extra.signal);

  // Delete an index template
  server.registerTool(
    "delete_index_template",
    {
      title: "Delete an index template",
      description: "Delete a composable index template. Indices already created keep their settings.",
      inputSchema: {
        name: z
          .string()
          .trim()
          .min(1, "Template name is required")
          .describe("Template name")
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ name }, extra) => {
      return await deleteIndexTemplate(es(extra), name);
    }
  );

  // Delete an index and everything in it
  server.registerTool(
    "delete_index",
    {
      title: "Delete an index",
      description: "Delete an index and every document in it. Irreversible. One concrete index name only: wildcards and lists are refused.",
      inputSchema: {
        index: z
          .string()
          .trim()
          .min(1, "Index name is required")
          .describe("Exact index name. No wildcard, no comma-separated list."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ index }, extra) => {
      return await deleteIndex(es(extra), index);
    }
  );

  // Delete one document
  server.registerTool(
    "delete_document",
    {
      title: "Delete a document",
      description: "Delete one document by its _id. Irreversible, though a missing document is reported rather than treated as a failure.",
      inputSchema: {
        index: z
          .string()
          .trim()
          .min(1, "Index name is required")
          .describe("Exact index name"),

        id: z
          .string()
          .trim()
          .min(1, "Document id is required")
          .describe("Document _id"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ index, id }, extra) => {
      return await deleteDocument(es(extra), index, id);
    }
  );

  // Delete everything a query matches
  server.registerTool(
    "delete_by_query",
    {
      title: "Delete documents by query",
      description: "Delete every document a query matches. Irreversible and unbounded: run count with the same query first to see how many would go. Asynchronous — it returns a task id and the deletion continues in the background, so follow it with get_task.",
      inputSchema: {
        index: z
          .string()
          .trim()
          .min(1, "Index name is required")
          .describe("Exact index name. No wildcard, no comma-separated list."),

        query: z
          .record(z.string(), z.any())
          .describe("Query DSL selecting what to delete. Required: there is no implicit delete-all."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ index, query }, extra) => {
      return await deleteByQuery(es(extra), index, query);
    }
  );
}
