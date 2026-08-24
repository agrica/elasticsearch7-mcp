import { describe, expect, it } from "vitest";
import { errorSummary } from "../src/tools/ecs/errorSummary.js";
import {
  capture,
  createMockedClient,
  failEveryRoute,
  firstRequest,
  hasErrorFragment,
  textOf,
} from "./support/mockClient.js";

const PATTERN = "logs-app-*";
const ROUTE = { method: "POST", path: "/logs-app-*/_search" };

type GroupInput = {
  key: string;
  count: number;
  first?: string;
  last?: string;
  services?: [string, number][];
  sample?: string;
};

function groups(entries: GroupInput[], other = 0) {
  return {
    took: 5,
    hits: {
      total: { value: entries.reduce((sum, entry) => sum + entry.count, 0), relation: "eq" },
      hits: [],
    },
    aggregations: {
      error_types: {
        sum_other_doc_count: other,
        buckets: entries.map((entry) => ({
          key: entry.key,
          doc_count: entry.count,
          first: { value_as_string: entry.first ?? "2026-08-25T09:00:00Z" },
          last: { value_as_string: entry.last ?? "2026-08-25T10:00:00Z" },
          services: {
            buckets: (entry.services ?? []).map(([name, count]) => ({
              key: name,
              doc_count: count,
            })),
          },
          sample: {
            hits: {
              hits: entry.sample
                ? [{ _index: "logs", _id: "1", _source: { "error.message": entry.sample } }]
                : [],
            },
          },
        })),
      },
    },
  };
}

describe("errorSummary", () => {
  it("groups on error.type, the only keyword there is to group on", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, groups([]));

    await errorSummary(client, PATTERN, {});
    const agg = firstRequest(captured).body.aggs.error_types;

    // ECS 1.x maps error.message as text with no keyword sub-field, so it
    // cannot be aggregated; error.stack_trace is keyword but carries
    // ignore_above, which would drop the long traces silently.
    expect(agg.terms.field).toBe("error.type");
    expect(firstRequest(captured).body.size).toBe(0);
  });

  it("gives events without an error.type their own bucket", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, groups([]));

    await errorSummary(client, PATTERN, {});

    // Without `missing`, a vendor that logs failures with only log.level and
    // message would make this tool answer "no errors" about a cluster full of
    // them — a wrong answer rather than a partial one.
    expect(firstRequest(captured).body.aggs.error_types.terms.missing).toBe("(no error.type)");
  });

  it("asks for the first and last occurrence, the services, and one sample", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, groups([]));

    await errorSummary(client, PATTERN, {});
    const sub = firstRequest(captured).body.aggs.error_types.aggs;

    expect(sub.first.min.field).toBe("@timestamp");
    expect(sub.last.max.field).toBe("@timestamp");
    expect(sub.services.terms.field).toBe("service.name");
    expect(sub.sample.top_hits.size).toBe(1);
    // Only the fields the sample line prints: a top_hits carrying the whole
    // _source is how an aggregation result grows to the size of a search result.
    expect(sub.sample.top_hits._source).toEqual(["message", "error.message"]);
  });

  it("imposes no level filter of its own", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, groups([]));

    await errorSummary(client, PATTERN, {});
    const filters = firstRequest(captured).body.query.bool.filter;

    // Whether a failure is marked by log.level or by the presence of error.*
    // depends on the logging library, so imposing either would decide the
    // question this tool is asked to answer.
    expect(filters.some((entry: any) => entry.terms?.["log.level"])).toBe(false);
  });

  it("clamps groups to the ceiling", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, groups([]));

    await errorSummary(client, PATTERN, { groups: 900 });

    expect(firstRequest(captured).body.aggs.error_types.terms.size).toBe(50);
  });

  it("renders each group with its count, span, services and sample", async () => {
    const { client, mock } = createMockedClient();
    capture(
      mock,
      ROUTE,
      groups([
        {
          key: "java.net.ConnectException",
          count: 412,
          first: "2026-08-25T09:14:02Z",
          last: "2026-08-25T10:57:31Z",
          services: [["billing", 400], ["checkout", 12]],
          sample: "Connection refused: db-1:5432",
        },
      ])
    );

    const text = textOf(await errorSummary(client, PATTERN, {}));

    expect(text).toContain("412 matching events in 1 error type");
    expect(text).toContain("java.net.ConnectException  ×412");
    expect(text).toContain("2026-08-25T09:14:02Z → 2026-08-25T10:57:31Z");
    expect(text).toContain("billing (400), checkout (12)");
    expect(text).toContain("Connection refused: db-1:5432");
  });

  it("says how many events fell outside the reported types", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, ROUTE, groups([{ key: "TimeoutError", count: 10 }], 37));

    // The no-silent-caps rule: a truncated list must say it is truncated, or a
    // model reads the tail as absent.
    const text = textOf(await errorSummary(client, PATTERN, {}));

    expect(text).toContain("37 events fall outside the top 10 types");
  });

  it("explains the untyped bucket rather than just printing it", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, ROUTE, groups([{ key: "(no error.type)", count: 88 }]));

    const text = textOf(await errorSummary(client, PATTERN, {}));

    expect(text).toContain("88 of these carry no `error.type`");
    expect(text).toContain("text with no keyword sub-field");
  });

  it("returns the failure as content rather than throwing", async () => {
    const { client, mock } = createMockedClient();
    failEveryRoute(mock);

    const result = await errorSummary(client, PATTERN, {});

    expect(hasErrorFragment(result)).toBe(true);
    expect(result.isError).toBe(true);
  });
});
