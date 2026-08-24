import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClientSource } from "../auth/clientSource.js";
import { clientRunner } from "./clientRunner.js";
import { indexName, requiredText } from "./schemas.js";
import { GET_MAPPINGS_OUTPUT, LIST_INDICES_OUTPUT } from "./outputSchemas.js";
import { listIndices } from "../tools/listIndices.js";
import { getMappings } from "../tools/getMappings.js";
import { search } from "../tools/search.js";
import { getClusterHealth } from "../tools/getClusterHealth.js";
import { createIndex } from "../tools/createIndex.js";
import { createMapping } from "../tools/createMapping.js";
import { bulk, MAX_BULK_DOCUMENTS } from "../tools/bulk.js";
import { reindex } from "../tools/reindex.js";
import { count } from "../tools/count.js";
import { getDocument } from "../tools/getDocument.js";
import { getAliases } from "../tools/aliases.js";
import { getTask } from "../tools/tasks.js";
import { getClusterInfo } from "../tools/settings.js";
import {
  createIndexTemplate,
  getIndexTemplate,
} from "../tools/createIndexTemplate.js";

/**
 * Tools that read data, or write it without destroying any. Always registered:
 * this is what the server is for.
 */
export function registerDataTools(server: McpServer, source: ClientSource): void {
  // Every handler reaches the cluster through this: it resolves the client —
  // obtaining an OAuth2 token when that factor is configured — wraps it so the
  // request aborts when the MCP client cancels, and turns an authentication
  // failure into a tool result rather than a protocol error. See
  // src/register/clientRunner.ts.
  const call = clientRunner(source);

  // list all indices
  server.registerTool(
    "list_indices",
    {
      title: "List indices",
      description: "List indices, one compact line each: name, health, status, document count and size in bytes. Large results are trimmed and say so.",
      inputSchema: {
        pattern: z
          .string()
          .optional()
          .describe("Elasticsearch wildcard, e.g. `logs-*`. Not a regex. Defaults to `*`."),

        verbose: z
          .boolean()
          .optional()
          .describe("Also repeat the rows as JSON text, for a client that does not read structured output."),
      },
      outputSchema: LIST_INDICES_OUTPUT,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ pattern, verbose }, extra) => call(extra, (es) => listIndices(es, pattern, verbose))
  );

  // get mappings for a specific index
  server.registerTool(
    "get_mappings",
    {
      title: "Get index mappings",
      description: "List the fields of one index as dotted paths with their types, nested fields included, then the raw mapping. Give a concrete index name: an alias or a wildcard returns nothing.",
      inputSchema: {
        index: indexName("Index name"),
      },
      outputSchema: GET_MAPPINGS_OUTPUT,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ index }, extra) => call(extra, (es) => getMappings(es, index))
  );

  // search with query DSL
  server.registerTool(
    "search",
    {
      title: "Search documents",
      description: "Search one index with a query DSL body. Matching text fields are highlighted. Paging goes inside queryBody (`size`, `from`); `size` is capped at 100 per call, so page with `from` for more.",
      inputSchema: {
        index: indexName("Index to search"),

        queryBody: z
          .record(z.string(), z.any())
          .refine(
            (val) => {
              try {
                JSON.parse(JSON.stringify(val));
                return true;
              } catch (e) {
                return false;
              }
            },
            {
              message: "queryBody must be a valid Elasticsearch query DSL object",
            }
          )
          .describe(
            "Query DSL body: query, size, from, sort, aggs, _source."
          ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ index, queryBody }, extra) => call(extra, (es) => search(es, index, queryBody))
  );

  // Get the health status of the Elasticsearch cluster, optionally include index-level details
  server.registerTool(
    "elasticsearch_health",
    {
      title: "Cluster health",
      description: "Cluster health: status, node counts and shard counts.",
      inputSchema: {
        includeIndices: z
          .boolean()
          .optional()
          .default(false)
          .describe("Add per-index health detail"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ includeIndices }, extra) => call(extra, (es) => getClusterHealth(es, includeIndices))
  );

  // Create an Elasticsearch index, optionally configure settings and mappings
  server.registerTool(
    "create_index",
    {
      title: "Create an index",
      description: "Create a new index. Fails if it already exists — use create_mapping to add fields to an existing one.",
      inputSchema: {
        index: indexName("Index name"),
      
        settings: z
          .record(z.string(), z.any())
          .optional()
          .describe("Index settings, e.g. number_of_shards, number_of_replicas"),
      
        mappings: z
          .record(z.string(), z.any())
          .optional()
          .describe("Field mappings, e.g. { properties: { title: { type: 'text' } } }")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ index, settings, mappings }, extra) => call(extra, (es) => createIndex(es, index, settings, mappings))
  );

  // Create or update the mapping structure of an Elasticsearch index
  server.registerTool(
    "create_mapping",
    {
      title: "Create or update a mapping",
      description: "Add or update fields on an index, creating the index if it does not exist. Elasticsearch cannot change the type of an existing field.",
      inputSchema: {
        index: indexName("Index name"),
      
        mappings: z
          .record(z.string(), z.any())
          .describe("Mapping to apply, e.g. { properties: { tags: { type: 'keyword' } } }")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ index, mappings }, extra) => call(extra, (es) => createMapping(es, index, mappings))
  );

  // Bulk import data into an Elasticsearch index
  server.registerTool(
    "bulk",
    {
      title: "Bulk index documents",
      description: "Index up to 1000 documents in one call. The index is refreshed by default, so they are searchable immediately; per-document failures are reported without failing the call.",
      inputSchema: {
        index: indexName("Target index"),
      
        documents: z
          .array(z.record(z.string(), z.any()))
          .min(1, "At least one document is required")
          .max(MAX_BULK_DOCUMENTS, `At most ${MAX_BULK_DOCUMENTS} documents per call`)
          .describe(`Documents to index, at most ${MAX_BULK_DOCUMENTS}. Send more in successive batches.`),

        idField: z
          .string()
          .optional()
          .describe("Field whose value becomes the document _id. Omit to let Elasticsearch generate ids."),

        refresh: z
          .boolean()
          .optional()
          .describe("Defaults to true, making documents searchable at once. Set false when loading many batches: forcing a refresh per batch is the expensive part.")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ index, documents, idField, refresh }, extra) => call(extra, (es) => bulk(es, index, documents, idField, refresh))
  );

  // Reindex from source to target index with optional query and script
  server.registerTool(
    "reindex",
    {
      title: "Reindex into another index",
      description: "Copy documents between indices. Asynchronous: returns a task id at once and the copy is still running on return — poll it with GET _tasks/<id>.",
      inputSchema: {
        sourceIndex: indexName("Source index", "Source index name is required"),
      
        destIndex: indexName("Destination index, created if absent", "Destination index name is required"),
      
        query: z
          .record(z.string(), z.any())
          .optional()
          .describe("Query DSL selecting which documents to copy. Omit to copy all."),
      
        // Shaped rather than a free-form record: an inline script requires a
        // `source`, so saying so lets the calling model get it right the first
        // time and keeps the type aligned with estypes.Script end to end.
        script: z
          .object({
            source: z
              .string()
              .describe(
                "Script body, e.g. \"ctx._source.level = 'info'\""
              ),
            lang: z
              .string()
              .optional()
              .describe("Script language, defaults to painless"),
            params: z
              .record(z.string(), z.any())
              .optional()
              .describe("Parameters the script refers to"),
          })
          .optional()
          .describe("Transform each document while copying")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ sourceIndex, destIndex, query, script }, extra) => call(extra, (es) => reindex(es, sourceIndex, destIndex, script, query))
  );

  // Create or update an index template
  server.registerTool(
    "create_index_template",
    {
      title: "Create or update an index template",
      description: "Create or update a composable index template (Elasticsearch 7.8+). It applies only to indices created after it, never to existing ones.",
      inputSchema: {
        name: requiredText("Template name", "Template name is required"),
      
        indexPatterns: z
          .array(z.string())
          .min(1, "At least one index pattern is required")
          .describe("Index wildcards the template applies to, e.g. ['logs-*']"),
      
        template: z
          .record(z.string(), z.any())
          .describe("What to apply: { settings, mappings, aliases }"),
      
        priority: z
          .number()
          .optional()
          .describe("Precedence when several templates match; higher wins"),
      
        version: z
          .number()
          .optional()
          .describe("Version number, for your own tracking")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ name, indexPatterns, template, priority, version }, extra) => call(extra, (es) => createIndexTemplate(es, name, indexPatterns, template, priority, version))
  );

  // Get index templates
  server.registerTool(
    "get_index_template",
    {
      title: "Get index templates",
      description: "Get composable index templates. Omit name to list all.",
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe("Template name. Omit to list every template.")
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ name }, extra) => call(extra, (es) => getIndexTemplate(es, name))
  );

  // Count matching documents without transferring them
  server.registerTool(
    "count",
    {
      title: "Count documents",
      description: "Count the documents matching a query, without transferring any. Cheaper than search when only the number matters.",
      inputSchema: {
        index: indexName("Index to count in"),

        query: z
          .record(z.string(), z.any())
          .optional()
          .describe("Query DSL. Omit to count every document."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ index, query }, extra) => call(extra, (es) => count(es, index, query))
  );

  // Fetch one document by id
  server.registerTool(
    "get_document",
    {
      title: "Get a document by id",
      description: "Fetch one document by its _id. Reports that it is absent rather than failing.",
      inputSchema: {
        index: indexName("Index holding the document"),

        id: requiredText("Document _id", "Document id is required"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ index, id }, extra) => call(extra, (es) => getDocument(es, index, id))
  );

  // Which aliases point where
  server.registerTool(
    "get_aliases",
    {
      title: "List aliases",
      description: "List which aliases point to which indices. A name you query may be an alias, which changes what get_mappings returns.",
      inputSchema: {
        index: z
          .string()
          .optional()
          .describe("Index or wildcard. Omit for the whole cluster."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ index }, extra) => call(extra, (es) => getAliases(es, index))
  );

  // Follow up an asynchronous task
  server.registerTool(
    "get_task",
    {
      title: "Get task progress",
      description: "Check an asynchronous task, such as the one reindex returns: progress, completion and failure.",
      inputSchema: {
        taskId: requiredText("Task id as returned by reindex, e.g. node-1:428", "Task id is required"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ taskId }, extra) => call(extra, (es) => getTask(es, taskId))
  );

  // Cluster identity and version
  server.registerTool(
    "cluster_info",
    {
      title: "Cluster version and identity",
      description: "Cluster name, Elasticsearch version and build flavour. The version decides which query DSL features exist.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (_args, extra) => call(extra, (es) => getClusterInfo(es))
  );
}
