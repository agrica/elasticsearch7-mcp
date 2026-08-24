import { describe, expect, it } from "vitest";
import { createIndex } from "../src/tools/createIndex.js";
import { bulk } from "../src/tools/bulk.js";
import { reindex } from "../src/tools/reindex.js";
import {
  capture,
  createMockedClient,
  firstRequest,
  hasErrorFragment,
  textOf,
} from "./support/mockClient.js";

describe("createIndex", () => {
  it("sends settings and mappings inside `body`", async () => {
    const { client, mock } = createMockedClient();
    const create = capture(mock, { method: "PUT", path: "/orders" }, {
      acknowledged: true,
      shards_acknowledged: true,
      index: "orders",
    });

    const text = textOf(
      await createIndex(
        client,
        "orders",
        { number_of_shards: 2 },
        { properties: { sku: { type: "keyword" } } }
      )
    );

    expect(firstRequest(create).body).toEqual({
      settings: { number_of_shards: 2 },
      mappings: { properties: { sku: { type: "keyword" } } },
    });
    expect(text).toContain("created successfully");
  });

  it("omits absent settings and mappings rather than sending nulls", async () => {
    const { client, mock } = createMockedClient();
    const create = capture(mock, { method: "PUT", path: "/plain" }, {
      acknowledged: true,
      shards_acknowledged: false,
      index: "plain",
    });

    await createIndex(client, "plain");

    expect(firstRequest(create).body).toEqual({});
  });

  it("flags an unacknowledged creation", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, { method: "PUT", path: "/slow" }, { acknowledged: false, shards_acknowledged: false, index: "slow" });
    expect(textOf(await createIndex(client, "slow"))).toContain("not acknowledged");
  });

  it("reports a cluster failure as an Error fragment", async () => {
    const { client } = createMockedClient();
    expect(hasErrorFragment(await createIndex(client, "nope"))).toBe(true);
  });
});

describe("bulk", () => {
  const DOCS = [
    { id: "a1", message: "first" },
    { id: "a2", message: "second" },
  ];

  function bulkResponse(items: unknown[]) {
    return { took: 7, errors: false, items };
  }

  it("builds ndjson action/document pairs and refreshes so docs are searchable", async () => {
    const { client, mock } = createMockedClient();
    const call = capture(
      mock,
      { method: "POST", path: "/_bulk" },
      bulkResponse([{ index: { _id: "a1", status: 201 } }, { index: { _id: "a2", status: 201 } }])
    );

    const text = textOf(await bulk(client, "orders", DOCS, "id"));

    // The mock parses ndjson into one array entry per line.
    expect(firstRequest(call).body).toEqual([
      { index: { _index: "orders", _id: "a1" } },
      { id: "a1", message: "first" },
      { index: { _index: "orders", _id: "a2" } },
      { id: "a2", message: "second" },
    ]);
    expect(firstRequest(call).querystring.refresh).toBe("true");
    expect(text).toContain("Successfully imported: 2");
    expect(text).toContain("Failed: 0");
    expect(text).toContain("Processing time: 7ms");
  });

  it("lets Elasticsearch assign ids when no idField is given", async () => {
    const { client, mock } = createMockedClient();
    const call = capture(mock, { method: "POST", path: "/_bulk" }, bulkResponse([{ index: { status: 201 } }]));

    await bulk(client, "orders", [{ message: "no id" }]);

    expect(firstRequest(call).body[0]).toEqual({ index: { _index: "orders" } });
  });

  it("reports per-document failures individually instead of failing the call", async () => {
    const { client, mock } = createMockedClient();
    capture(
      mock,
      { method: "POST", path: "/_bulk" },
      bulkResponse([
        { index: { _id: "a1", status: 201 } },
        {
          index: {
            _id: "a2",
            status: 400,
            error: { type: "mapper_parsing_exception", reason: "failed to parse field" },
          },
        },
      ])
    );

    const result = await bulk(client, "orders", DOCS, "id");
    const text = textOf(result);

    expect(text).toContain("Successfully imported: 1");
    expect(text).toContain("Failed: 1");
    expect(text).toContain("ID: a2");
    expect(text).toContain("mapper_parsing_exception");
    // A partial failure is not a tool failure.
    expect(hasErrorFragment(result)).toBe(false);
  });

  it("rejects an empty document list without calling the cluster", async () => {
    const { client, mock } = createMockedClient();
    const call = capture(mock, { method: "POST", path: "/_bulk" }, bulkResponse([]));

    const result = await bulk(client, "orders", []);

    expect(hasErrorFragment(result)).toBe(true);
    expect(call.requests).toHaveLength(0);
  });
});

describe("reindex", () => {
  it("runs asynchronously and returns the task id to poll", async () => {
    const { client, mock } = createMockedClient();
    const call = capture(mock, { method: "POST", path: "/_reindex" }, { task: "node-1:428" });

    const text = textOf(await reindex(client, "old-logs", "new-logs"));

    expect(firstRequest(call).querystring.wait_for_completion).toBe("false");
    expect(firstRequest(call).body).toEqual({
      source: { index: "old-logs" },
      dest: { index: "new-logs" },
    });
    expect(text).toContain("Task ID: node-1:428");
    expect(text).toContain("GET _tasks/node-1:428");
  });

  it("nests an optional query under source and the script at body level", async () => {
    const { client, mock } = createMockedClient();
    const call = capture(mock, { method: "POST", path: "/_reindex" }, { task: "node-1:429" });

    await reindex(
      client,
      "old-logs",
      "new-logs",
      { source: "ctx._source.level = 'info'", lang: "painless" },
      { term: { level: "debug" } }
    );

    expect(firstRequest(call).body).toEqual({
      source: { index: "old-logs", query: { term: { level: "debug" } } },
      dest: { index: "new-logs" },
      script: { source: "ctx._source.level = 'info'", lang: "painless" },
    });
  });

  it("reports a cluster failure as an Error fragment", async () => {
    const { client } = createMockedClient();
    expect(hasErrorFragment(await reindex(client, "a", "b"))).toBe(true);
  });
});
