import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Client } from "@elastic/elasticsearch";
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
  // Delete an index template
  server.tool(
    "delete_index_template",
    "Delete a composable index template. Indices already created keep their settings.",
    {
      name: z
        .string()
        .trim()
        .min(1, "Template name is required")
        .describe("Template name")
    },
    async ({ name }) => {
      return await deleteIndexTemplate(esClient, name);
    }
  );

  // Delete an index and everything in it
  server.tool(
    "delete_index",
    "Delete an index and every document in it. Irreversible. One concrete index name only: wildcards and lists are refused.",
    {
      index: z
        .string()
        .trim()
        .min(1, "Index name is required")
        .describe("Exact index name. No wildcard, no comma-separated list."),
    },
    async ({ index }) => {
      return await deleteIndex(esClient, index);
    }
  );

  // Delete one document
  server.tool(
    "delete_document",
    "Delete one document by its _id. Irreversible, though a missing document is reported rather than treated as a failure.",
    {
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
    async ({ index, id }) => {
      return await deleteDocument(esClient, index, id);
    }
  );

  // Delete everything a query matches
  server.tool(
    "delete_by_query",
    "Delete every document a query matches. Irreversible and unbounded: run count with the same query first to see how many would go.",
    {
      index: z
        .string()
        .trim()
        .min(1, "Index name is required")
        .describe("Exact index name. No wildcard, no comma-separated list."),

      query: z
        .record(z.string(), z.any())
        .describe("Query DSL selecting what to delete. Required: there is no implicit delete-all."),
    },
    async ({ index, query }) => {
      return await deleteByQuery(esClient, index, query);
    }
  );
}
