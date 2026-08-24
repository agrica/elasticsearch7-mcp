#!/usr/bin/env node
/**
 * Measure what one tool call puts into the caller's context.
 *
 * This is the harness behind the figures in
 * `docs/architecture-review-2026-08-24.md`. It exists as a committed script so
 * the next review re-runs it instead of rebuilding it — a review whose numbers
 * cannot be reproduced stops being checkable the day after it is written.
 *
 * Usage:
 *   pnpm run build
 *   node scripts/measure-output.mjs
 *
 * No cluster is contacted: the Elasticsearch client is mocked at its connection
 * layer, and the fixtures are a year of daily indices — 365 indices, 2190
 * shards, 500 log hits.
 *
 * The same shapes are defined in `test/support/scaleFixtures.ts`, which holds
 * the ceilings as a test. They are two definitions of one thing and must be
 * kept in step: this script is plain JS and deliberately outside the build, so
 * it cannot import the typed fixtures, and the alternative — dropping `strict`
 * typing on the fixtures so both could share one file — would weaken the test
 * to tidy the script. The counts each side asserts (365 / 2190 / 500) are what
 * make a drift visible.
 */

import { Client } from "@elastic/elasticsearch";
import ElasticsearchMock from "@elastic/elasticsearch-mock";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createElasticsearchMcpServer } from "../dist/src/server.js";
import { listIndices } from "../dist/src/tools/listIndices.js";
import { listNodes, listShards } from "../dist/src/tools/diagnostics.js";
import { search } from "../dist/src/tools/search.js";
import { getClusterHealth } from "../dist/src/tools/getClusterHealth.js";
import { getMappings } from "../dist/src/tools/getMappings.js";

const INFO = {
  name: "es-node-1",
  cluster_name: "logging-cluster",
  cluster_uuid: "AAAAAAAAAAAAAAAAAAAAAA",
  version: {
    number: "7.8.0",
    build_flavor: "default",
    lucene_version: "8.5.1",
  },
  tagline: "You Know, for Search",
};

function mockedClient(routes) {
  const mock = new ElasticsearchMock();
  mock.add({ method: "GET", path: "/" }, () => INFO);
  for (const [path, body] of routes) {
    mock.add({ method: ["GET", "POST"], path }, () => body);
  }
  return new Client({
    node: "http://localhost:9200",
    Connection: mock.getConnection(),
  });
}

const textBytes = (result) =>
  Buffer.byteLength((result?.content ?? []).map((f) => f.text).join("\n"), "utf8");

const structuredBytes = (result) =>
  result?.structuredContent
    ? Buffer.byteLength(JSON.stringify(result.structuredContent), "utf8")
    : 0;

// Both halves reach the caller's context, so both are measured. Reporting only
// the fragments would show a result as half its size the moment a tool gained an
// output schema.
const bytes = (result) => textBytes(result) + structuredBytes(result);

// Bytes / 4 is a rule of thumb, not a tokeniser. Stated here so the number in
// the report is not mistaken for a measurement it is not.
const tokens = (n) => Math.round(n / 4);

function row(label, size, structured = 0) {
  const split = structured > 0 ? `  (${structured} B structured)` : "";
  console.log(
    `  ${label.padEnd(42)} ${String(size).padStart(7)} B   ~${String(
      tokens(size)
    ).padStart(6)} tokens${split}`
  );
}

/** Measure a tool result, reporting the structured share where there is one. */
function measure(label, result) {
  row(label, bytes(result), structuredBytes(result));
}

// ---------------------------------------------------------------- fixtures

const indices = Array.from({ length: 365 }, (_, i) => ({
  index: `logs-2025.${String((i % 12) + 1).padStart(2, "0")}.${String(
    (i % 28) + 1
  ).padStart(2, "0")}`,
  health: "green",
  status: "open",
  pri: "3",
  rep: "1",
  "docs.count": String(4_000_000 + i),
  "docs.deleted": "120",
  "store.size": String(3_500_000_000 + i),
  "pri.store.size": String(1_700_000_000 + i),
  uuid: `uuid-${i}`,
}));

const shards = indices.flatMap((index) =>
  [0, 1, 2].flatMap((shard) =>
    ["p", "r"].map((prirep) => ({
      index: index.index,
      shard: String(shard),
      prirep,
      state: "STARTED",
      docs: "1333333",
      store: "1166666666",
      node: `es-node-${(shard % 3) + 1}`,
    }))
  )
);

const hits = Array.from({ length: 500 }, (_, i) => ({
  _index: "logs",
  _id: String(i),
  _score: 1,
  _source: {
    "@timestamp": "2026-08-24T10:00:00Z",
    level: "ERROR",
    host: `srv-${i % 20}`,
    message: `Connection pool exhausted while acquiring a lease for tenant ${i} after 30000ms; retrying`,
    stack:
      "at com.example.Pool.acquire(Pool.java:142)\n\tat com.example.Svc.run(Svc.java:88)",
  },
}));

const mapping1000 = Object.fromEntries(
  Array.from({ length: 1000 }, (_, i) => [
    `field_${i}`,
    { type: i % 3 === 0 ? "text" : "keyword" },
  ])
);

const nodes = Array.from({ length: 24 }, (_, i) => ({
  name: `es-node-${i + 1}`,
  "node.role": "dilm",
  master: i === 0 ? "*" : "-",
  "heap.percent": "71",
  "ram.percent": "94",
  cpu: "35",
  load_1m: "1.20",
  "disk.used_percent": "88.4",
  "disk.avail": "12884901888",
}));

// ---------------------------------------------------------------- tool output

console.log(
  `\nTool output — 365 daily indices, ${shards.length} shards, 500 log hits\n`
);

measure(
  "list_indices",
  await listIndices(mockedClient([["/_cat/indices/*", indices]]))
);
measure(
  "list_indices (verbose)",
  await listIndices(mockedClient([["/_cat/indices/*", indices]]), undefined, true)
);
measure("list_shards", await listShards(mockedClient([["/_cat/shards", shards]])));
measure(
  "list_shards (verbose)",
  await listShards(mockedClient([["/_cat/shards", shards]]), undefined, true)
);
measure("list_nodes", await listNodes(mockedClient([["/_cat/nodes", nodes]])));

// A thousand-field mapping, which is what a logging index looks like. This tool
// was outside the measured set until it gained an output schema, and it used to
// return the whole mapping pretty-printed with no budget at all.
measure(
  "get_mappings, 1000 fields",
  await getMappings(
    mockedClient([["/logs/_mapping", { logs: { mappings: { properties: mapping1000 } } }]]),
    "logs"
  )
);

measure(
  "search, size: 500 requested",
  (
    await search(
      mockedClient([
        ["/logs/_mapping", { logs: { mappings: { properties: { message: { type: "text" } } } } }],
        [
          "/logs/_search",
          { took: 12, hits: { total: { value: 98_421, relation: "eq" }, max_score: 1, hits } },
        ],
      ]),
      "logs",
      { size: 500 }
    )
  )
);

measure(
  "elasticsearch_health, index detail",
  (
    await getClusterHealth(
      mockedClient([
        [
          "/_cluster/health",
          {
            cluster_name: "logging-cluster",
            status: "green",
            number_of_nodes: 24,
            number_of_data_nodes: 24,
            active_primary_shards: 1095,
            active_shards: 2190,
            relocating_shards: 0,
            initializing_shards: 0,
            unassigned_shards: 0,
            indices: Object.fromEntries(
              indices.map((index) => [
                index.index,
                {
                  status: "green",
                  number_of_shards: 3,
                  number_of_replicas: 1,
                  active_primary_shards: 3,
                  active_shards: 6,
                  unassigned_shards: 0,
                },
              ])
            ),
          },
        ],
      ]),
      true
    )
  )
);

// ---------------------------------------------------------------- tools/list

console.log("\nSchema cost — the tools/list payload, per configuration\n");

for (const [label, flags] of [
  ["data only (default)", {}],
  ["+ ES_ADMIN_TOOLS", { adminTools: true }],
  ["+ ES_ALLOW_DESTRUCTIVE (both)", { adminTools: true, allowDestructive: true }],
]) {
  // Port 1 cannot be bound, so nothing is contacted: listing tools never
  // reaches Elasticsearch.
  const server = await createElasticsearchMcpServer({
    urls: ["http://127.0.0.1:1"],
    ...flags,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new McpClient({ name: "measure", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const { tools } = await client.listTools();
  row(
    `${label} (${tools.length} tools)`,
    Buffer.byteLength(JSON.stringify(tools), "utf8")
  );
  await client.close();
}

console.log("");
