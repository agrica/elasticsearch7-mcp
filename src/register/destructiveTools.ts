import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClientSource } from "../auth/clientSource.js";
import { clientRunner } from "./clientRunner.js";
import { indexName, requiredText } from "./schemas.js";
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
  source: ClientSource
): void {
  // Every handler reaches the cluster through this: it resolves the client —
  // obtaining an OAuth2 token when that factor is configured — wraps it so the
  // request aborts when the MCP client cancels, and turns an authentication
  // failure into a tool result rather than a protocol error. See
  // src/register/clientRunner.ts.
  const call = clientRunner(source);

  // Delete an index template
  server.registerTool(
    "delete_index_template",
    {
      title: "Delete an index template",
      description: "Delete a composable index template. Indices already created keep their settings.",
      inputSchema: {
        name: requiredText("Template name", "Template name is required")
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ name }, extra) => call(extra, (es) => deleteIndexTemplate(es, name))
  );

  // Delete an index and everything in it
  server.registerTool(
    "delete_index",
    {
      title: "Delete an index",
      description: "Delete an index and every document in it. Irreversible. One concrete index name only: wildcards and lists are refused.",
      inputSchema: {
        index: indexName("Exact index name. No wildcard, no comma-separated list."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ index }, extra) => call(extra, (es) => deleteIndex(es, index))
  );

  // Delete one document
  server.registerTool(
    "delete_document",
    {
      title: "Delete a document",
      description: "Delete one document by its _id. Irreversible, though a missing document is reported rather than treated as a failure.",
      inputSchema: {
        index: indexName("Exact index name"),

        id: requiredText("Document _id", "Document id is required"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ index, id }, extra) => call(extra, (es) => deleteDocument(es, index, id))
  );

  // Delete everything a query matches
  server.registerTool(
    "delete_by_query",
    {
      title: "Delete documents by query",
      description: "Delete every document a query matches. Irreversible and unbounded: run count with the same query first to see how many would go. Asynchronous — it returns a task id and the deletion continues in the background, so follow it with get_task.",
      inputSchema: {
        index: indexName("Exact index name. No wildcard, no comma-separated list."),

        query: z
          .record(z.string(), z.any())
          .describe("Query DSL selecting what to delete. Required: there is no implicit delete-all."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ index, query }, extra) => call(extra, (es) => deleteByQuery(es, index, query))
  );
}
