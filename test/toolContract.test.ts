import { describe, expect, it } from "vitest";
import type { Client } from "@elastic/elasticsearch";
import { bulk } from "../src/tools/bulk.js";
import { createIndex } from "../src/tools/createIndex.js";
import {
  createIndexTemplate,
  deleteIndexTemplate,
  getIndexTemplate,
} from "../src/tools/createIndexTemplate.js";
import { createMapping } from "../src/tools/createMapping.js";
import { count } from "../src/tools/count.js";
import { getDocument } from "../src/tools/getDocument.js";
import { getAliases } from "../src/tools/aliases.js";
import { getTask, listTasks } from "../src/tools/tasks.js";
import {
  explainAllocation,
  getIndexStats,
  listNodes,
  listShards,
} from "../src/tools/diagnostics.js";
import {
  getClusterInfo,
  getClusterSettings,
  getIndexSettings,
} from "../src/tools/settings.js";
import {
  deleteByQuery,
  deleteDocument,
  deleteIndex,
} from "../src/tools/destructive.js";
import { getClusterHealth } from "../src/tools/getClusterHealth.js";
import { getMappings } from "../src/tools/getMappings.js";
import { listIndices } from "../src/tools/listIndices.js";
import { reindex } from "../src/tools/reindex.js";
import { search } from "../src/tools/search.js";
import {
  capture,
  createMockedClient,
  failEveryRoute,
  hasErrorFragment,
  isFailure,
  type ToolResult,
} from "./support/mockClient.js";

/**
 * The contract every tool must honour: never throw, always return the MCP
 * content shape, and surface a failure as readable text the calling model can
 * act on. A throw would reach the client as an opaque transport error instead.
 */
const TOOLS: [name: string, invoke: (client: Client) => Promise<ToolResult>][] = [
  ["list_indices", (c) => listIndices(c)],
  ["get_mappings", (c) => getMappings(c, "logs")],
  ["search", (c) => search(c, "logs", { query: { match_all: {} } })],
  ["elasticsearch_health", (c) => getClusterHealth(c, true)],
  ["create_index", (c) => createIndex(c, "logs", { number_of_shards: 1 })],
  ["create_mapping", (c) => createMapping(c, "logs", { properties: {} })],
  ["bulk", (c) => bulk(c, "logs", [{ message: "x" }])],
  ["reindex", (c) => reindex(c, "logs", "logs-copy")],
  ["create_index_template", (c) => createIndexTemplate(c, "t", ["t-*"], {})],
  ["get_index_template", (c) => getIndexTemplate(c, "t")],
  ["delete_index_template", (c) => deleteIndexTemplate(c, "t")],
  ["count", (c) => count(c, "logs")],
  ["get_document", (c) => getDocument(c, "logs", "1")],
  ["get_aliases", (c) => getAliases(c)],
  ["get_task", (c) => getTask(c, "node:1")],
  ["list_tasks", (c) => listTasks(c)],
  ["explain_allocation", (c) => explainAllocation(c, "logs", 0, true)],
  ["list_shards", (c) => listShards(c)],
  ["get_index_stats", (c) => getIndexStats(c, "logs")],
  ["list_nodes", (c) => listNodes(c)],
  ["get_index_settings", (c) => getIndexSettings(c, "logs")],
  ["get_cluster_settings", (c) => getClusterSettings(c)],
  // cluster_info is absent on purpose: it calls `GET /`, the one route
  // failEveryRoute leaves alive for the product check. It gets its own test
  // below.
  // The destructive tools honour the same contract. Their targets are single
  // concrete index names on purpose: a pattern would be refused by the
  // guardrail before any request is sent, so the cluster failure — the thing
  // this suite is checking — would never be reached.
  ["delete_index", (c) => deleteIndex(c, "logs")],
  ["delete_document", (c) => deleteDocument(c, "logs", "1")],
  ["delete_by_query", (c) => deleteByQuery(c, "logs", { match_all: {} })],
];

describe("tool contract, with every cluster call failing", () => {
  it.each(TOOLS)("%s reports the failure instead of throwing", async (_name, invoke) => {
    const { client, mock } = createMockedClient();
    failEveryRoute(mock);

    const result = await invoke(client);

    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
    for (const fragment of result.content) {
      expect(fragment.type).toBe("text");
      expect(typeof fragment.text).toBe("string");
    }
    expect(hasErrorFragment(result)).toBe(true);
    // The protocol's own failure signal. Without it a client has to match on
    // the text, which is a convention and not a contract.
    expect(result.isError, `${_name} must set isError on failure`).toBe(true);
  });

  it("cluster_info reports the failure instead of throwing", async () => {
    const { client, mock } = createMockedClient();

    // The product check runs once, on the first request, and against `GET /` —
    // the same route cluster_info uses. Warm it first, then break the route, so
    // what fails is the tool's own call and not the client's handshake.
    await client.info();
    mock.clear({ method: "GET", path: "/" });
    failEveryRoute(mock);

    const result = await getClusterInfo(client);

    expect(isFailure(result)).toBe(true);
  });

  it("leaves isError unset when the call succeeds", async () => {
    // Omitted rather than false: the protocol defaults it, and a success that
    // carries the field invites a client to read it as meaningful.
    const { client, mock } = createMockedClient();
    capture(mock, { method: "GET", path: "/_cat/indices/*" }, []);

    const result = await listIndices(client);

    expect(result.isError).toBeUndefined();
  });

  it("marks a guardrail refusal as a failure, not a quiet success", async () => {
    // The refusal path sends nothing to the cluster, so nothing throws. A model
    // reading a success here would conclude the index had been deleted.
    const { client } = createMockedClient();

    const result = await deleteIndex(client, "logs-*");

    expect(isFailure(result)).toBe(true);
    expect(result.content[0]?.text).toContain("Refusing");
  });
});
