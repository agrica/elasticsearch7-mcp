import { describe, expect, it } from "vitest";
import { topValues } from "../src/tools/ecs/topValues.js";
import {
  capture,
  createMockedClient,
  failEveryRoute,
  failRouteWith,
  firstRequest,
  hasErrorFragment,
  isFailure,
  textOf,
} from "./support/mockClient.js";

const PATTERN = "logs-app-*";
const ROUTE = { method: "POST", path: "/logs-app-*/_search" };

function values(entries: [string, number][], other = 0, total?: number) {
  const sum = entries.reduce((accumulator, [, count]) => accumulator + count, 0);
  return {
    took: 2,
    hits: { total: { value: total ?? sum + other, relation: "eq" }, hits: [] },
    aggregations: {
      values: {
        sum_other_doc_count: other,
        buckets: entries.map(([key, count]) => ({ key, doc_count: count })),
      },
    },
  };
}

describe("topValues", () => {
  it("aggregates the requested field, with no documents returned", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, values([]));

    await topValues(client, PATTERN, "log.level", {});
    const body = firstRequest(captured).body;

    expect(body.aggs.values.terms.field).toBe("log.level");
    expect(body.size).toBe(0);
  });

  it("labels documents where the field is absent", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, values([]));

    await topValues(client, PATTERN, "service.name", {});

    expect(firstRequest(captured).body.aggs.values.terms.missing).toBe("(missing)");
  });

  it("clamps size to the ceiling", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, values([]));

    await topValues(client, PATTERN, "log.level", { size: 10_000 });

    expect(firstRequest(captured).body.aggs.values.terms.size).toBe(100);
  });

  it("carries the shared filters through", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, values([]));

    await topValues(client, PATTERN, "log.level", { service: "billing", since: "6h" });
    const filters = firstRequest(captured).body.query.bool.filter;

    expect(filters).toContainEqual({ terms: { "service.name": ["billing"] } });
    expect(filters).toContainEqual({ range: { "@timestamp": { gte: "now-6h" } } });
  });

  it("reports each value with its count and share", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, ROUTE, values([["INFO", 750], ["ERROR", 250]]));

    const text = textOf(await topValues(client, PATTERN, "log.level", {}));

    expect(text).toContain("2 distinct values of log.level across 1000 events");
    expect(text).toContain("INFO   750  (75%)");
    expect(text).toContain("ERROR  250  (25%)");
  });

  it("says how many events hold a value it did not list", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, ROUTE, values([["INFO", 10]], 992));

    expect(textOf(await topValues(client, PATTERN, "service.name", {}))).toContain(
      "992 events hold a value outside the top 10"
    );
  });

  it("refuses a window it cannot parse, before sending anything", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, values([]));

    const result = await topValues(client, PATTERN, "log.level", { since: "soon" });

    expect(isFailure(result)).toBe(true);
    expect(captured.requests).toHaveLength(0);
  });

  it("returns the failure as content rather than throwing", async () => {
    const { client, mock } = createMockedClient();
    failEveryRoute(mock);

    const result = await topValues(client, PATTERN, "log.level", {});

    expect(hasErrorFragment(result)).toBe(true);
    expect(result.isError).toBe(true);
  });
});

describe("topValues on an analysed field", () => {
  /**
   * The one cluster error worth translating. Elasticsearch says what it will not
   * do — fielddata is disabled — but not what to do instead, and the answer is
   * almost always the same field with `.keyword`, or an ECS keyword field. This
   * is the same choice made for the WWW-Authenticate diagnostic: no allow-list
   * that would refuse a legitimate custom field, a message that names the fix.
   */
  it("names the keyword alternatives instead of forwarding the raw error", async () => {
    const { client, mock } = createMockedClient();
    // The shape Elasticsearch really answers with: the sentence naming
    // fielddata is in the root cause, not in the outer reason.
    failRouteWith(mock, ROUTE, 400, {
      type: "search_phase_execution_exception",
      reason: "all shards failed",
      rootCause: {
        type: "illegal_argument_exception",
        reason:
          "Fielddata is disabled on text fields by default. Set fielddata=true on [message] " +
          "in order to load fielddata in memory by uninverting the inverted index.",
      },
    });

    const result = await topValues(client, PATTERN, "message", {});

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("message.keyword");
    expect(text).toContain("log.level");
    expect(text).toContain("field_caps");
  });
});
