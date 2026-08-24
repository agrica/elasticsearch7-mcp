import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Client } from "@elastic/elasticsearch";
import { listIndices } from "../tools/listIndices.js";
import { getMappings } from "../tools/getMappings.js";
import { search } from "../tools/search.js";
import { getClusterHealth } from "../tools/getClusterHealth.js";
import { createIndex } from "../tools/createIndex.js";
import { createMapping } from "../tools/createMapping.js";
import { bulk } from "../tools/bulk.js";
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
export function registerDataTools(server: McpServer, esClient: Client): void {
  // list all indices
  server.tool(
    "list_indices",
    "List indices. Returns name, health, status, document count and size in bytes.",
    {
      pattern: z
        .string()
        .optional()
        .describe("Elasticsearch wildcard, e.g. `logs-*`. Not a regex. Defaults to `*`."),
    },
    async ({ pattern }) => {
      return await listIndices(esClient, pattern);
    }
  );

  // get mappings for a specific index
  server.tool(
    "get_mappings",
    "Get the field mappings of one index. Give a concrete index name: an alias or a wildcard returns an empty mapping.",
    {
      index: z
        .string()
        .trim()
        .min(1, "Index name is required")
        .describe("Index name"),
    },
    async ({ index }) => {
      return await getMappings(esClient, index);
    }
  );

  // search with query DSL
  server.tool(
    "search",
    "Search one index with a query DSL body. Matching text fields are highlighted. Paging goes inside queryBody (`size`, `from`).",
    {
      index: z
        .string()
        .trim()
        .min(1, "Index name is required")
        .describe("Index to search"),

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
    async ({ index, queryBody }) => {
      return await search(esClient, index, queryBody);
    }
  );

  // Get the health status of the Elasticsearch cluster, optionally include index-level details
  server.tool(
    "elasticsearch_health",
    "Cluster health: status, node counts and shard counts.",
    {
      includeIndices: z
        .boolean()
        .optional()
        .default(false)
        .describe("Add per-index health detail"),
    },
    async ({ includeIndices }) => {
      return await getClusterHealth(esClient, includeIndices);
    }
  );

  // Create an Elasticsearch index, optionally configure settings and mappings
  server.tool(
    "create_index",
    "Create a new index. Fails if it already exists — use create_mapping to add fields to an existing one.",
    {
      index: z
        .string()
        .trim()
        .min(1, "Index name is required")
        .describe("Index name"),
      
      settings: z
        .record(z.string(), z.any())
        .optional()
        .describe("Index settings, e.g. number_of_shards, number_of_replicas"),
      
      mappings: z
        .record(z.string(), z.any())
        .optional()
        .describe("Field mappings, e.g. { properties: { title: { type: 'text' } } }")
    },
    async ({ index, settings, mappings }) => {
      return await createIndex(esClient, index, settings, mappings);
    }
  );

  // Create or update the mapping structure of an Elasticsearch index
  server.tool(
    "create_mapping",
    "Add or update fields on an index, creating the index if it does not exist. Elasticsearch cannot change the type of an existing field.",
    {
      index: z
        .string()
        .trim()
        .min(1, "Index name is required")
        .describe("Index name"),
      
      mappings: z
        .record(z.string(), z.any())
        .describe("Mapping to apply, e.g. { properties: { tags: { type: 'keyword' } } }")
    },
    async ({ index, mappings }) => {
      return await createMapping(esClient, index, mappings);
    }
  );

  // Bulk import data into an Elasticsearch index
  server.tool(
    "bulk",
    "Index documents in bulk. The index is refreshed, so they are searchable immediately; per-document failures are reported without failing the call.",
    {
      index: z
        .string()
        .trim()
        .min(1, "Index name is required")
        .describe("Target index"),
      
      documents: z
        .array(z.record(z.string(), z.any()))
        .min(1, "At least one document is required")
        .describe("Documents to index"),
      
      idField: z
        .string()
        .optional()
        .describe("Field whose value becomes the document _id. Omit to let Elasticsearch generate ids.")
    },
    async ({ index, documents, idField }) => {
      return await bulk(esClient, index, documents, idField);
    }
  );

  // Reindex from source to target index with optional query and script
  server.tool(
    "reindex",
    "Copy documents between indices. Asynchronous: returns a task id at once and the copy is still running on return — poll it with GET _tasks/<id>.",
    {
      sourceIndex: z
        .string()
        .trim()
        .min(1, "Source index name is required")
        .describe("Source index"),
      
      destIndex: z
        .string()
        .trim()
        .min(1, "Destination index name is required")
        .describe("Destination index, created if absent"),
      
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
    async ({ sourceIndex, destIndex, query, script }) => {
      return await reindex(esClient, sourceIndex, destIndex, script, query);
    }
  );

  // Create or update an index template
  server.tool(
    "create_index_template",
    "Create or update a composable index template (Elasticsearch 7.8+). It applies only to indices created after it, never to existing ones.",
    {
      name: z
        .string()
        .trim()
        .min(1, "Template name is required")
        .describe("Template name"),
      
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
    async ({ name, indexPatterns, template, priority, version }) => {
      return await createIndexTemplate(esClient, name, indexPatterns, template, priority, version);
    }
  );

  // Get index templates
  server.tool(
    "get_index_template",
    "Get composable index templates. Omit name to list all.",
    {
      name: z
        .string()
        .optional()
        .describe("Template name. Omit to list every template.")
    },
    async ({ name }) => {
      return await getIndexTemplate(esClient, name);
    }
  );

  // Count matching documents without transferring them
  server.tool(
    "count",
    "Count the documents matching a query, without transferring any. Cheaper than search when only the number matters.",
    {
      index: z
        .string()
        .trim()
        .min(1, "Index name is required")
        .describe("Index to count in"),

      query: z
        .record(z.string(), z.any())
        .optional()
        .describe("Query DSL. Omit to count every document."),
    },
    async ({ index, query }) => {
      return await count(esClient, index, query);
    }
  );

  // Fetch one document by id
  server.tool(
    "get_document",
    "Fetch one document by its _id. Reports that it is absent rather than failing.",
    {
      index: z
        .string()
        .trim()
        .min(1, "Index name is required")
        .describe("Index holding the document"),

      id: z
        .string()
        .trim()
        .min(1, "Document id is required")
        .describe("Document _id"),
    },
    async ({ index, id }) => {
      return await getDocument(esClient, index, id);
    }
  );

  // Which aliases point where
  server.tool(
    "get_aliases",
    "List which aliases point to which indices. A name you query may be an alias, which changes what get_mappings returns.",
    {
      index: z
        .string()
        .optional()
        .describe("Index or wildcard. Omit for the whole cluster."),
    },
    async ({ index }) => {
      return await getAliases(esClient, index);
    }
  );

  // Follow up an asynchronous task
  server.tool(
    "get_task",
    "Check an asynchronous task, such as the one reindex returns: progress, completion and failure.",
    {
      taskId: z
        .string()
        .trim()
        .min(1, "Task id is required")
        .describe("Task id as returned by reindex, e.g. node-1:428"),
    },
    async ({ taskId }) => {
      return await getTask(esClient, taskId);
    }
  );

  // Cluster identity and version
  server.tool(
    "cluster_info",
    "Cluster name, Elasticsearch version and build flavour. The version decides which query DSL features exist.",
    {},
    async () => {
      return await getClusterInfo(esClient);
    }
  );
}
