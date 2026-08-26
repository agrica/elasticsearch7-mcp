import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ElasticsearchConfigInput } from "../src/config/schema.js";
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
  "analyze",
  "bulk",
  "cluster_info",
  "count",
  "create_index",
  "create_index_template",
  "create_mapping",
  "elasticsearch_health",
  "field_caps",
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
  "get_node_stats",
  "list_nodes",
  "list_shards",
  "list_tasks",
];

const ECS_TOOLS = [
  "error_summary",
  "log_histogram",
  "search_logs",
  "top_values",
  "trace_request",
];

const DESTRUCTIVE_TOOLS = [
  "delete_by_query",
  "delete_document",
  "delete_index",
  "delete_index_template",
];

async function connectedClient(
  flags: Partial<Omit<ElasticsearchConfigInput, "urls">> = {}
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

  it("declares an output schema on the tabular tools and nowhere else", async () => {
    // Four, not twenty-six: an output schema is paid for in every session's
    // `tools/list`, and earns it only where a caller would otherwise parse
    // prose. This is also the guard for the pairing — the SDK rejects a
    // successful result that has a schema but no structured payload, so a
    // schema added here without one in the tool is a runtime protocol error.
    const { client } = await connectedClient({ adminTools: true });

    const { tools } = await client.listTools();
    const structured = tools
      .filter((tool) => tool.outputSchema)
      .map((tool) => tool.name)
      .sort();

    expect(structured).toEqual([
      "get_index_settings",
      "get_mappings",
      "list_indices",
      "list_shards",
    ]);
    for (const tool of tools.filter((tool) => tool.outputSchema)) {
      expect(tool.outputSchema?.type).toBe("object");
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

  it("gives every tool a title and behaviour annotations", async () => {
    const { client } = await connectedClient({
      adminTools: true,
      allowDestructive: true,
    });
    const { tools } = await client.listTools();

    for (const tool of tools) {
      expect(tool.title, `${tool.name} has no title`).toBeTruthy();
      expect(tool.annotations, `${tool.name} has no annotations`).toBeTruthy();
      // openWorldHint is true for every tool here: they all act on a cluster
      // whose state changes outside this server's control.
      expect(tool.annotations?.openWorldHint).toBe(true);
    }
    await client.close();
  });

  it("annotates the whole diagnostic set as read-only, which is its premise", async () => {
    // ES_ADMIN_TOOLS is documented as safe to enable in production *because*
    // these only read. That claim was prose; this makes it checkable, so a
    // future tool added to the wrong set fails here instead of being enabled on
    // a production cluster on the strength of a paragraph.
    const { client } = await connectedClient({ adminTools: true });
    const { tools } = await client.listTools();

    for (const name of ADMIN_TOOLS) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.annotations?.readOnlyHint, `${name} must be read-only`).toBe(true);
      expect(tool?.annotations?.destructiveHint, `${name} must not be destructive`).not.toBe(true);
    }
    await client.close();
  });

  it("marks every destructive tool destructive, and none of the others", async () => {
    const { client } = await connectedClient({
      adminTools: true,
      allowDestructive: true,
    });
    const { tools } = await client.listTools();

    const destructive = tools
      .filter((tool) => tool.annotations?.destructiveHint === true)
      .map((tool) => tool.name)
      .sort();

    // Exact, both ways: a delete missing the hint gets no confirmation prompt
    // from a client that offers one, and a read tool wrongly carrying it
    // trains the user to click through the prompt.
    expect(destructive).toEqual([...DESTRUCTIVE_TOOLS].sort());
    for (const name of DESTRUCTIVE_TOOLS) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.annotations?.readOnlyHint, `${name} cannot be read-only`).toBe(false);
    }
    await client.close();
  });

  it("does not claim idempotence where a second call fails", async () => {
    // create_index fails when the index exists, and delete_index 404s once the
    // index is gone. A client that retries on the strength of idempotentHint
    // would turn a success into an error.
    const { client } = await connectedClient({ allowDestructive: true });
    const { tools } = await client.listTools();

    for (const name of ["create_index", "delete_index", "bulk", "reindex"]) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.annotations?.idempotentHint, `${name} is not idempotent`).toBe(false);
    }
    await client.close();
  });

  it("reports a failed token exchange as a tool error, not a protocol error", async () => {
    // The trap this guards: the client is resolved in the handler, *outside* the
    // tool's own error handling, so a rejected token request would reach the SDK
    // and come back as a JSON-RPC error. Every failure in this server has to
    // arrive as readable content carrying isError instead.
    const { client } = await connectedClient({
      oauth: {
        // Port 1 cannot be bound, so the token request is refused at once
        // rather than waiting out a timeout.
        tokenUrl: "https://127.0.0.1:1/token",
        clientId: "mcp",
        clientSecret: "s3cr3t",
      },
    });

    const result = (await client.callTool({
      name: "list_indices",
      arguments: {},
    })) as { isError?: boolean; content: { text: string }[] };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Authentication failed");
    await client.close();
  });

  it("says which authentication factor is in force, and which are ignored", async () => {
    // A silent precedence is how an operator ships the wrong identity: they
    // leave ES_API_KEY in place, OAuth2 wins, and nothing says so.
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((message: unknown) => {
      lines.push(String(message));
    });

    const { client } = await connectedClient({
      apiKey: "left-over-key",
      oauth: {
        tokenUrl: "https://idp.example.test/token",
        clientId: "mcp-elasticsearch",
        clientSecret: "s3cr3t",
        scope: "es:read",
      },
    });

    const startup = lines.join("\n");
    expect(startup).toContain("OAuth2 client_credentials as mcp-elasticsearch");
    expect(startup).toContain("ES_API_KEY ignored");
    // Never the secret, on any line.
    expect(startup).not.toContain("s3cr3t");

    spy.mockRestore();
    await client.close();
  });

  it("carries the instance label into the server title", async () => {
    // One mcpServers block often declares the same server twice, against a
    // production cluster and a staging one. The title is what tells them apart
    // in a client, without reading each entry's environment.
    const { client } = await connectedClient({ instanceLabel: "staging" });

    expect(client.getServerVersion()?.title).toBe("Elasticsearch 7.x — staging");
    await client.close();
  });

  it("falls back to a plain title when no label is set", async () => {
    const { client } = await connectedClient();

    expect(client.getServerVersion()?.title).toBe("Elasticsearch 7.x");
    await client.close();
  });

  it("keeps the ECS log tools off until ES_ECS_TOOLS enables them", async () => {
    const { client } = await connectedClient();
    const names = (await client.listTools()).tools.map((tool) => tool.name);

    // A cluster whose logs are not in ECS would otherwise pay for four tool
    // schemas that can only ever return nothing.
    for (const tool of ECS_TOOLS) {
      expect(names, `${tool} must not be registered by default`).not.toContain(tool);
    }
    await client.close();
  });

  it("registers the ECS log tools when the flag and the pattern are both set", async () => {
    const { client } = await connectedClient({
      ecsTools: true,
      ecsIndexPattern: "logs-app-*",
    });
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();

    expect(names).toEqual([...DATA_TOOLS, ...ECS_TOOLS].sort());
    await client.close();
  });

  it("refuses to start when the ECS tools are on without an index pattern", async () => {
    // Deliberately the harsh treatment — the one a partial OAuth2 block gets,
    // not the one a malformed ES_MAX_RETRIES gets. A guess like `logs-*` is not
    // a default: it would sweep whichever indices happen to match and answer
    // confidently from the wrong data.
    await expect(
      createElasticsearchMcpServer({
        urls: ["http://127.0.0.1:1"],
        ecsTools: true,
      })
    ).rejects.toThrow(/ES_ECS_INDEX_PATTERN/);
  });

  it("marks every ECS log tool read-only", async () => {
    const { client } = await connectedClient({
      ecsTools: true,
      ecsIndexPattern: "logs-app-*",
    });
    const { tools } = await client.listTools();

    for (const name of ECS_TOOLS) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.annotations?.readOnlyHint, `${name} must be read-only`).toBe(true);
    }
    await client.close();
  });

  it("tells the caller that error grouping is by type, and why", async () => {
    // The fact a caller cannot infer and gets wrong: ECS 1.x maps error.message
    // as text with no keyword sub-field, so grouping by message is impossible.
    const { client } = await connectedClient({
      ecsTools: true,
      ecsIndexPattern: "logs-app-*",
    });
    const { tools } = await client.listTools();

    const summary = tools.find((tool) => tool.name === "error_summary");
    expect(summary?.description).toMatch(/error\.type/);
    expect(summary?.description).toMatch(/keyword sub-field/);
    await client.close();
  });

  it("says field_caps takes a wildcard, which get_mappings does not", async () => {
    const { client } = await connectedClient();
    const { tools } = await client.listTools();

    const caps = tools.find((tool) => tool.name === "field_caps");
    expect(caps?.description).toMatch(/wildcard/i);
    // The reason it earns its place: a type conflict is invisible otherwise.
    expect(caps?.description).toMatch(/two different types|more than one type/i);
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
