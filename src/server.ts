import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@elastic/elasticsearch";
import {
  ConfigSchema,
  type ElasticsearchConfigInput,
  createClientOptions,
} from "./config/schema.js";
import { registerDataTools } from "./register/dataTools.js";
import { registerAdminTools } from "./register/adminTools.js";
import { registerDestructiveTools } from "./register/destructiveTools.js";

import { listIndices } from "./tools/listIndices.js";
import { getMappings } from "./tools/getMappings.js";
import { search } from "./tools/search.js";
import { getClusterHealth } from "./tools/getClusterHealth.js";
import { createIndex } from "./tools/createIndex.js";
import { createMapping } from "./tools/createMapping.js";
import { bulk } from "./tools/bulk.js";
import { reindex } from "./tools/reindex.js";
import { count } from "./tools/count.js";
import { getDocument } from "./tools/getDocument.js";
import { getAliases } from "./tools/aliases.js";
import { getTask, listTasks } from "./tools/tasks.js";
import {
  explainAllocation,
  getIndexStats,
  listNodes,
  listShards,
} from "./tools/diagnostics.js";
import {
  getClusterInfo,
  getClusterSettings,
  getIndexSettings,
} from "./tools/settings.js";
import {
  deleteByQuery,
  deleteDocument,
  deleteIndex,
} from "./tools/destructive.js";
import {
  createIndexTemplate,
  getIndexTemplate,
  deleteIndexTemplate,
} from "./tools/createIndexTemplate.js";

export {
  listIndices,
  getMappings,
  search,
  getClusterHealth,
  createIndex,
  createMapping,
  bulk,
  reindex,
  count,
  getDocument,
  getAliases,
  getTask,
  listTasks,
  explainAllocation,
  getIndexStats,
  listNodes,
  listShards,
  getClusterInfo,
  getClusterSettings,
  getIndexSettings,
  deleteByQuery,
  deleteDocument,
  deleteIndex,
  createIndexTemplate,
  getIndexTemplate,
  deleteIndexTemplate,
};

export { registerDataTools, registerAdminTools, registerDestructiveTools };

/**
 * Build the server and register the tools this deployment is allowed to expose.
 *
 * The gating is registration, not a runtime check: a tool that is never
 * registered does not appear in `tools/list`, so a model cannot call it and it
 * costs nothing in context.
 */
export async function createElasticsearchMcpServer(
  config: ElasticsearchConfigInput
) {
  const validated = ConfigSchema.parse(config);
  const esClient = new Client(createClientOptions(validated));

  // `title` is the display name a client shows. ES_INSTANCE_LABEL goes here so
  // an operator running this server against several clusters — production and
  // staging both declared in one mcpServers block — can tell which is which
  // without reading the env of each entry.
  const server = new McpServer({
    name: "mcp-server-elasticsearch7",
    version: "0.1.0",
    title: validated.instanceLabel
      ? `Elasticsearch 7.x — ${validated.instanceLabel}`
      : "Elasticsearch 7.x",
  });

  registerDataTools(server, esClient);

  if (validated.adminTools) {
    registerAdminTools(server, esClient);
  }

  if (validated.allowDestructive) {
    registerDestructiveTools(server, esClient);
  }

  // stderr, never stdout: stdout carries the MCP protocol. An operator needs to
  // be able to tell which sets are live without calling tools/list.
  console.error(
    `Instance: ${validated.instanceLabel || "(unlabelled — set ES_INSTANCE_LABEL)"}`
  );
  console.error(
    `Tool sets: data (always) | diagnostics ${
      validated.adminTools ? "ON" : "OFF (set ES_ADMIN_TOOLS=true)"
    } | destructive ${
      validated.allowDestructive ? "ON" : "OFF (set ES_ALLOW_DESTRUCTIVE=true)"
    }`
  );

  return server;
}
