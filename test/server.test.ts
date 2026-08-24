import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createElasticsearchMcpServer } from "../src/server.js";

/**
 * Covers the registration layer over a real MCP session, which the tool tests
 * bypass entirely. Its value is upgrade safety: the SDK's zod version and its
 * registration API are the parts that move between releases, and a broken
 * `server.tool()` call would otherwise only surface in a client.
 *
 * No cluster is contacted — building the server only constructs an ES client.
 */
const DATA_TOOLS = [
  "bulk",
  "cluster_info",
  "count",
  "create_index",
  "create_index_template",
  "create_mapping",
  "elasticsearch_health",
  "get_aliases",
  "get_document",
  "get_index_template",
  "get_mappings",
  "get_task",
  "list_indices",
  "reindex",
  "search",
];

const ADMIN_TOOLS = [
  "explain_allocation",
  "get_cluster_settings",
  "get_index_settings",
  "get_index_stats",
  "list_nodes",
  "list_shards",
  "list_tasks",
];

const DESTRUCTIVE_TOOLS = [
  "delete_by_query",
  "delete_document",
  "delete_index",
  "delete_index_template",
];

async function connectedClient(
  flags: { adminTools?: boolean; allowDestructive?: boolean } = {}
) {
  // Port 1 cannot be bound without privileges, so the connection is refused
  // instantly and identically everywhere. Pointing at localhost:9200 would make
  // these tests depend on the host: that is this project's own documented dev
  // endpoint, so a developer running Elasticsearch locally would see the
  // failure-path assertion below succeed against a real cluster.
  const server = await createElasticsearchMcpServer({
    urls: ["http://127.0.0.1:1"],
    ...flags,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return { client, server };
}

describe("MCP server registration", () => {
  it("exposes only the data tools by default", async () => {
    const { client } = await connectedClient();

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(DATA_TOOLS);
    await client.close();
  });

  it("gives every tool a description and an input schema", async () => {
    const { client } = await connectedClient();

    const { tools } = await client.listTools();

    for (const tool of tools) {
      // The description and the per-field descriptions are what the calling
      // model reads to decide how to invoke the tool; empty ones make a tool
      // unusable without any error being raised.
      expect(tool.description, `${tool.name} has no description`).toBeTruthy();
      expect(tool.inputSchema, `${tool.name} has no input schema`).toBeTruthy();
      expect(tool.inputSchema.type).toBe("object");
    }
    await client.close();
  });

  it("describes every field of the search tool's schema", async () => {
    const { client } = await connectedClient();

    const { tools } = await client.listTools();
    const search = tools.find((tool) => tool.name === "search");
    const properties = (search?.inputSchema.properties ?? {}) as Record<
      string,
      { description?: string }
    >;

    expect(Object.keys(properties).sort()).toEqual(["index", "queryBody"]);
    for (const [field, schema] of Object.entries(properties)) {
      expect(schema.description, `search.${field} has no description`).toBeTruthy();
    }
    await client.close();
  });

  it("accepts an arbitrary query DSL object through the zod schema", async () => {
    // The real risk of the zod 3 -> 4 migration: `z.record(z.any())` had to
    // become `z.record(z.string(), z.any())`, and a stricter schema would
    // reject valid input. Reaching the cluster call — and failing there, since
    // nothing listens on 9200 — proves validation let the arguments through.
    const { client } = await connectedClient();

    const result = (await client.callTool({
      name: "search",
      arguments: {
        index: "logs",
        queryBody: { size: 1, query: { bool: { must: [{ match: { message: "x" } }] } } },
      },
    })) as { content: { type: string; text: string }[]; isError?: boolean };

    const text = result.content.map((fragment) => fragment.text).join(" | ");
    expect(text).toContain("Error:");
    // A schema rejection would name the field instead of failing to connect.
    expect(text).not.toContain("queryBody");
    await client.close();
  }, 20_000);
  it("never advertises regex support for a wildcard parameter", async () => {
    // `pattern` goes straight to the cat API as an Elasticsearch wildcard. The
    // description used to say "support regex", so a calling model would send
    // `^logs-` and get nothing back with no hint why.
    const { client } = await connectedClient();

    const { tools } = await client.listTools();
    const listIndices = tools.find((tool) => tool.name === "list_indices");
    const pattern = (listIndices?.inputSchema.properties as Record<
      string,
      { description?: string }
    >)?.pattern;

    expect(pattern?.description).toMatch(/wildcard/i);
    expect(listIndices?.description).not.toMatch(/regex/i);
    expect(pattern?.description).not.toMatch(/is a regex|support regex|regex pattern/i);
    await client.close();
  });

  it("tells the caller that reindex does not wait for completion", async () => {
    // reindex passes wait_for_completion: false. A caller that assumes the copy
    // is done on return will read the destination too early.
    const { client } = await connectedClient();

    const { tools } = await client.listTools();
    const reindex = tools.find((tool) => tool.name === "reindex");

    expect(reindex?.description).toMatch(/asynchronous|task id/i);
    await client.close();
  });
  it("keeps the diagnostic tools off until ES_ADMIN_TOOLS enables them", async () => {
    const { client } = await connectedClient();
    const names = (await client.listTools()).tools.map((tool) => tool.name);

    for (const tool of ADMIN_TOOLS) {
      expect(names, `${tool} must not be exposed by default`).not.toContain(tool);
    }
    await client.close();
  });

  it("registers the diagnostic tools when asked, keeping the data ones", async () => {
    const { client } = await connectedClient({ adminTools: true });
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();

    expect(names).toEqual([...DATA_TOOLS, ...ADMIN_TOOLS].sort());
    await client.close();
  });

  it("keeps every destructive tool off until ES_ALLOW_DESTRUCTIVE enables them", async () => {
    // Including delete_index_template, which used to be exposed unconditionally:
    // leaving one delete reachable in production while gating the others would
    // be incoherent.
    const { client } = await connectedClient({ adminTools: true });
    const names = (await client.listTools()).tools.map((tool) => tool.name);

    for (const tool of DESTRUCTIVE_TOOLS) {
      expect(names, `${tool} must not be exposed by default`).not.toContain(tool);
    }
    await client.close();
  });

  it("registers the destructive tools when asked", async () => {
    const { client } = await connectedClient({
      adminTools: true,
      allowDestructive: true,
    });
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();

    expect(names).toEqual(
      [...DATA_TOOLS, ...ADMIN_TOOLS, ...DESTRUCTIVE_TOOLS].sort()
    );
    await client.close();
  });

  it("says out loud, in every destructive description, that it is irreversible", async () => {
    // The gate decides whether the tool exists; the description is what stops a
    // model from reaching for it casually once it does.
    const { client } = await connectedClient({ allowDestructive: true });
    const { tools } = await client.listTools();

    for (const name of ["delete_index", "delete_document", "delete_by_query"]) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.description, `${name} must warn`).toMatch(/irreversible/i);
    }
    await client.close();
  });
});
