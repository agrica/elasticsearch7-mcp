import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@elastic/elasticsearch";
import {
  ConfigSchema,
  type ElasticsearchConfigInput,
  createClientOptions,
} from "./config/schema.js";
import { setResultBudget } from "./outputBudget.js";
import { createClientSource } from "./auth/clientSource.js";
import { createTokenProvider } from "./auth/oauth2.js";
import { registerDataTools } from "./register/dataTools.js";
import { registerAdminTools } from "./register/adminTools.js";
import { registerDestructiveTools } from "./register/destructiveTools.js";
import { registerEcsTools } from "./register/ecsTools.js";

import { listIndices } from "./tools/listIndices.js";
import { getMappings } from "./tools/getMappings.js";
import { fieldCaps } from "./tools/fieldCaps.js";
import { analyze } from "./tools/analyze.js";
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
import { searchLogs } from "./tools/ecs/searchLogs.js";
import { logHistogram } from "./tools/ecs/logHistogram.js";
import { errorSummary } from "./tools/ecs/errorSummary.js";
import { topValues } from "./tools/ecs/topValues.js";
import { traceRequest } from "./tools/ecs/traceRequest.js";

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
  fieldCaps,
  analyze,
  searchLogs,
  logHistogram,
  errorSummary,
  topValues,
  traceRequest,
};

export {
  registerDataTools,
  registerAdminTools,
  registerDestructiveTools,
  registerEcsTools,
};

// The authentication surface, exported for the same reason as the tools: a
// library consumer, and `scripts/smoke.mjs`, need to build the client the way
// the server does rather than reimplementing the token flow.
export { createClientSource, type ClientSource } from "./auth/clientSource.js";
export { createTokenProvider, type OAuthConfig, type TokenProvider } from "./auth/oauth2.js";

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

  // The tools are handed a source rather than the client itself, because with
  // OAuth2 the answer changes as the token rotates. Without OAuth2 this is the
  // same client every time — see src/auth/clientSource.ts.
  const clientSource = createClientSource(
    esClient,
    validated.oauth ? createTokenProvider(validated.oauth) : undefined
  );

  // Applied before any tool can run. See src/outputBudget.ts for why this is
  // process state and not an argument on every tool.
  setResultBudget(validated.maxResultBytes);

  // `title` is the display name a client shows. ES_INSTANCE_LABEL goes here so
  // an operator running this server against several clusters — production and
  // staging both declared in one mcpServers block — can tell which is which
  // without reading the env of each entry.
  const server = new McpServer({
    name: "mcp-server-elasticsearch7",
    version: "0.3.0",
    title: validated.instanceLabel
      ? `Elasticsearch 7.x — ${validated.instanceLabel}`
      : "Elasticsearch 7.x",
  });

  registerDataTools(server, clientSource);

  if (validated.adminTools) {
    registerAdminTools(server, clientSource);
  }

  if (validated.allowDestructive) {
    registerDestructiveTools(server, clientSource);
  }

  // The pattern is fixed here rather than passed per call: which indices this
  // server may search is the operator's decision, and a tool argument would let
  // the calling model widen it.
  if (validated.ecsTools) {
    registerEcsTools(server, clientSource, validated.ecsIndexPattern);
  }

  // stderr, never stdout: stdout carries the MCP protocol. An operator needs to
  // be able to tell which sets are live without calling tools/list.
  console.error(
    `Instance: ${validated.instanceLabel || "(unlabelled — set ES_INSTANCE_LABEL)"}`
  );
  console.error(
    `Limits: ${validated.requestTimeoutMs}ms per request, ${validated.maxRetries} retries, ` +
      `${validated.maxResultBytes} bytes per result`
  );

  // Which identity this server presents, named out loud. Never the secret, and
  // never the token.
  if (validated.oauth) {
    console.error(
      `Auth: OAuth2 client_credentials as ${validated.oauth.clientId} via ${validated.oauth.tokenUrl}` +
        (validated.oauth.scope ? ` (scope ${validated.oauth.scope})` : "")
    );

    // A leftover ES_API_KEY is not an error — OAuth2 wins, and the base client
    // carries no auth at all — but an operator who thinks the key is in use
    // deserves to know it is not. Shipping the wrong identity is what silent
    // precedence produces.
    const ignored = [
      validated.apiKey ? "ES_API_KEY" : undefined,
      validated.username && validated.password ? "ES_USERNAME/ES_PASSWORD" : undefined,
    ].filter((name): name is string => name !== undefined);

    if (ignored.length > 0) {
      console.error(
        `Auth: ${ignored.join(" and ")} ignored — OAuth2 takes precedence.`
      );
    }
  } else if (validated.apiKey) {
    console.error("Auth: API key");
  } else if (validated.username && validated.password) {
    console.error(`Auth: basic, as ${validated.username}`);
  } else {
    console.error("Auth: none configured");
  }
  console.error(
    `Tool sets: data (always) | diagnostics ${
      validated.adminTools ? "ON" : "OFF (set ES_ADMIN_TOOLS=true)"
    } | destructive ${
      validated.allowDestructive ? "ON" : "OFF (set ES_ALLOW_DESTRUCTIVE=true)"
    } | ECS logs ${
      validated.ecsTools
        ? `ON (${validated.ecsIndexPattern})`
        : "OFF (set ES_ECS_TOOLS=true)"
    }`
  );

  return server;
}
