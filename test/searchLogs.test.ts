import { describe, expect, it } from "vitest";
import { searchLogs } from "../src/tools/ecs/searchLogs.js";
import {
  capture,
  createMockedClient,
  failEveryRoute,
  firstRequest,
  hasErrorFragment,
  isFailure,
  textOf,
} from "./support/mockClient.js";

const PATTERN = "logs-app-*";
const ROUTE = { method: "POST", path: "/logs-app-*/_search" };

function hit(source: Record<string, unknown>) {
  return { _index: "logs-app-2026.08.25", _id: "1", _score: null, _source: source };
}

function response(hits: ReturnType<typeof hit>[], total = hits.length) {
  return { took: 3, hits: { total: { value: total, relation: "eq" }, hits } };
}

describe("searchLogs", () => {
  it("sends the filters as a bool filter, nested under body", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, response([]));

    await searchLogs(client, PATTERN, {
      service: "billing",
      env: "prod",
      levels: ["error"],
      since: "15m",
      host: ["srv-1", "srv-2"],
      traceId: "abc123",
      requestId: "req-9",
    });

    // Nested under `body` — the 7.x shape. This is what the connection-level
    // mock exists to catch: a DSL sent as top-level parameters would be
    // accepted by a hand-rolled fake and dropped by the real client.
    const body = firstRequest(captured).body;
    const filters = body.query.bool.filter;

    expect(filters).toContainEqual({ range: { "@timestamp": { gte: "now-15m" } } });
    expect(filters).toContainEqual({ terms: { "service.name": ["billing"] } });
    expect(filters).toContainEqual({ terms: { "host.name": ["srv-1", "srv-2"] } });
    expect(filters).toContainEqual({ terms: { "trace.id": ["abc123"] } });
    expect(filters).toContainEqual({ terms: { "http.request.id": ["req-9"] } });
    // Without this one, a cluster that collects several environments answers a
    // per-service question with the sum across all of them, and says nothing
    // about it being a sum.
    expect(filters).toContainEqual({ terms: { "service.environment": ["prod"] } });

    const levelFilter = filters.find((entry: any) => entry.terms?.["log.level"]);
    expect(levelFilter.terms["log.level"]).toContain("ERROR");
    expect(levelFilter.terms["log.level"]).toContain("SEVERE");
  });

  it("defaults to the last fifteen minutes rather than everything", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, response([]));

    await searchLogs(client, PATTERN, {});

    expect(firstRequest(captured).body.query.bool.filter).toContainEqual({
      range: { "@timestamp": { gte: "now-15m" } },
    });
  });

  it("adds lte only when until is given", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, response([]));

    await searchLogs(client, PATTERN, { since: "2h", until: "1h" });

    expect(firstRequest(captured).body.query.bool.filter).toContainEqual({
      range: { "@timestamp": { gte: "now-2h", lte: "now-1h" } },
    });
  });

  it("sorts newest first and asks only for the fields it prints", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, response([]));

    await searchLogs(client, PATTERN, {});
    const body = firstRequest(captured).body;

    expect(body.sort).toEqual([{ "@timestamp": { order: "desc" } }]);
    // The measured decision: the whole _source on five hundred ECS events is
    // the difference between an answer and an exhausted budget.
    expect(body._source).toContain("@timestamp");
    expect(body._source).toContain("message");
    expect(body._source).not.toContain("error.stack_trace");
  });

  it("requests the stack trace only when it will be printed", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, response([]));

    await searchLogs(client, PATTERN, { verbose: true });

    expect(firstRequest(captured).body._source).toContain("error.stack_trace");
  });

  it("puts free text in must, over both ECS text fields", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, response([]));

    await searchLogs(client, PATTERN, { query: "connection refused" });
    const bool = firstRequest(captured).body.query.bool;

    expect(bool.must).toEqual([
      {
        multi_match: {
          query: "connection refused",
          fields: ["message", "error.message"],
        },
      },
    ]);
  });

  it("clamps limit to the measured ceiling", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, response([]));

    await searchLogs(client, PATTERN, { limit: 5000 });

    expect(firstRequest(captured).body.size).toBe(100);
  });

  it("defaults to twenty, not to the ceiling", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, response([]));

    await searchLogs(client, PATTERN, {});

    expect(firstRequest(captured).body.size).toBe(20);
  });

  it("renders one line per event, with the columns in place", async () => {
    const { client, mock } = createMockedClient();
    capture(
      mock,
      ROUTE,
      response([
        hit({
          "@timestamp": "2026-08-25T10:00:00.000Z",
          "log.level": "ERROR",
          "service.name": "billing",
          "host.name": "srv-3",
          "error.type": "java.net.ConnectException",
          message: "Connection refused",
        }),
      ])
    );

    const text = textOf(await searchLogs(client, PATTERN, {}));

    expect(text).toContain("1 matching events");
    expect(text).toContain("2026-08-25T10:00:00.000Z  ERROR  billing  srv-3");
    expect(text).toContain("[java.net.ConnectException] Connection refused");
  });

  it("reads a nested _source as well as a dotted one", async () => {
    // ECS documents arrive both ways depending on how the shipper serialises
    // them, and a reader that handled only one would print dashes for a real
    // field — a gap that reads as missing data.
    const { client, mock } = createMockedClient();
    capture(
      mock,
      ROUTE,
      response([
        hit({
          "@timestamp": "2026-08-25T10:00:00.000Z",
          log: { level: "WARN" },
          service: { name: "checkout" },
          message: "Slow response",
        }),
      ])
    );

    const text = textOf(await searchLogs(client, PATTERN, {}));

    expect(text).toContain("WARN  checkout");
    expect(text).toContain("Slow response");
  });

  it("says nothing matched, and how to find out why", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, ROUTE, response([], 0));

    const text = textOf(await searchLogs(client, PATTERN, { service: "typo" }));

    // A keyword filter that does not match the indexed spelling returns nothing
    // rather than an error, so the empty answer has to point at the cause.
    expect(text).toContain("No events matched");
    expect(text).toContain("top_values");
  });

  it("refuses an unparseable window instead of guessing one", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, response([]));

    const result = await searchLogs(client, PATTERN, { since: "yesterday" });

    expect(isFailure(result)).toBe(true);
    expect(textOf(result)).toContain("since");
    // And no request was sent: guessing a window would answer from the wrong
    // data, which is worse than refusing.
    expect(captured.requests).toHaveLength(0);
  });

  it("refuses a minLevel it cannot order, and names the alternative", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, response([]));

    const result = await searchLogs(client, PATTERN, { minLevel: "AUDIT" });

    expect(isFailure(result)).toBe(true);
    expect(textOf(result)).toContain("levels");
    expect(captured.requests).toHaveLength(0);
  });

  it("returns the failure as content rather than throwing", async () => {
    const { client, mock } = createMockedClient();
    failEveryRoute(mock);

    const result = await searchLogs(client, PATTERN, {});

    expect(hasErrorFragment(result)).toBe(true);
    expect(result.isError).toBe(true);
  });
});
