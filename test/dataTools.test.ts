import { describe, expect, it } from "vitest";
import { count } from "../src/tools/count.js";
import { getDocument } from "../src/tools/getDocument.js";
import { getAliases } from "../src/tools/aliases.js";
import { getTask } from "../src/tools/tasks.js";
import { getClusterInfo } from "../src/tools/settings.js";
import {
  capture,
  createMockedClient,
  failEveryRoute,
  firstRequest,
  hasErrorFragment,
  textOf,
} from "./support/mockClient.js";

describe("count", () => {
  it("counts everything with no body, which the client sends as GET", async () => {
    const { client, mock } = createMockedClient();
    const call = capture(
      mock,
      { method: ["GET", "POST"], path: "/logs/_count" },
      { count: 4213 }
    );

    const text = textOf(await count(client, "logs"));

    // The client picks the verb from the presence of a body, so omitting the
    // query really does mean "no body on the wire".
    expect(firstRequest(call).method).toBe("GET");
    expect(firstRequest(call).body).toBeNull();
    expect(text).toContain("4213 documents in");
  });

  it("wraps a query in the body", async () => {
    const { client, mock } = createMockedClient();
    const call = capture(
      mock,
      { method: ["GET", "POST"], path: "/logs/_count" },
      { count: 12 }
    );

    const text = textOf(await count(client, "logs", { term: { level: "error" } }));

    expect(firstRequest(call).method).toBe("POST");
    expect(firstRequest(call).body).toEqual({ query: { term: { level: "error" } } });
    expect(text).toContain("12 documents match the query");
  });

  it("reports a cluster failure rather than throwing", async () => {
    const { client, mock } = createMockedClient();
    failEveryRoute(mock);
    expect(hasErrorFragment(await count(client, "logs"))).toBe(true);
  });
});

describe("get_document", () => {
  it("returns the source of a document that exists", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, { method: "GET", path: "/logs/_doc/a1" }, {
      _index: "logs",
      _id: "a1",
      _version: 3,
      found: true,
      _source: { message: "disk full", level: "error" },
    });

    const text = textOf(await getDocument(client, "logs", "a1"));

    expect(text).toContain("version 3");
    expect(text).toContain('"message": "disk full"');
  });

  it("reports an absent document as an answer, not a failure", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, { method: "GET", path: "/logs/_doc/ghost" }, {
      _index: "logs",
      _id: "ghost",
      found: false,
    });

    const result = await getDocument(client, "logs", "ghost");

    expect(hasErrorFragment(result)).toBe(false);
    expect(textOf(result)).toContain("not found");
  });
});

describe("get_aliases", () => {
  it("shows which aliases point at which index", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, { method: "GET", path: "/_alias" }, {
      "logs-2026.08": { aliases: { logs: {}, "logs-current": {} } },
      "logs-2026.07": { aliases: {} },
    });

    const text = textOf(await getAliases(client));

    expect(text).toContain("logs-2026.08 <- logs, logs-current");
    // An index with no alias is not worth a line.
    expect(text).not.toContain("logs-2026.07");
  });

  it("says so when nothing carries an alias", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, { method: "GET", path: "/_alias" }, {});

    expect(textOf(await getAliases(client))).toContain("No alias defined");
  });
});

describe("get_task", () => {
  it("reports progress of a running reindex, which is what the status carries", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, { method: "GET", path: "/_tasks/node-1:428" }, {
      completed: false,
      task: {
        action: "indices:data/write/reindex",
        running_time_in_nanos: 45_000_000_000,
        cancellable: true,
        status: { total: 1000, created: 400, updated: 0, deleted: 0 },
      },
    });

    const text = textOf(await getTask(client, "node-1:428"));

    expect(text).toContain("still running");
    expect(text).toContain("Running for: 45s");
    expect(text).toContain('"created": 400');
  });

  it("surfaces a task that failed", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, { method: "GET", path: "/_tasks/node-1:429" }, {
      completed: true,
      task: { action: "indices:data/write/reindex", running_time_in_nanos: 1, cancellable: false },
      error: { type: "search_phase_execution_exception", reason: "all shards failed" },
    });

    const text = textOf(await getTask(client, "node-1:429"));

    expect(text).toContain("completed");
    expect(text).toContain("The task failed");
    expect(text).toContain("all shards failed");
  });
});

describe("cluster_info", () => {
  it("reports the version, which decides what query DSL is available", async () => {
    const { client } = createMockedClient(); // GET / is pre-registered as 7.8.0

    const text = textOf(await getClusterInfo(client));

    expect(text).toContain("Elasticsearch: 7.8.0 (default)");
    expect(text).toContain("logging-cluster");
  });
});
