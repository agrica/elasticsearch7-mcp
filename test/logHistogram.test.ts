import { describe, expect, it } from "vitest";
import { logHistogram } from "../src/tools/ecs/logHistogram.js";
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

function buckets(entries: [string, number][]) {
  return {
    took: 2,
    hits: { total: { value: entries.reduce((sum, [, n]) => sum + n, 0), relation: "eq" }, hits: [] },
    aggregations: {
      over_time: {
        buckets: entries.map(([when, count]) => ({
          key_as_string: when,
          key: 0,
          doc_count: count,
        })),
      },
    },
  };
}

describe("logHistogram", () => {
  it("asks for a date_histogram with fixed_interval, and no documents", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, buckets([]));

    await logHistogram(client, PATTERN, { since: "1d", interval: "1h" });
    const body = firstRequest(captured).body;

    // `fixed_interval`, not the deprecated `interval` a 7.x cluster warns about.
    expect(body.aggs.over_time.date_histogram).toMatchObject({
      field: "@timestamp",
      fixed_interval: "1h",
    });
    // The buckets are the answer; documents would only be paid for.
    expect(body.size).toBe(0);
  });

  it("derives the bucket width from the window when none is given", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, buckets([]));

    await logHistogram(client, PATTERN, { since: "15m" });

    expect(
      firstRequest(captured).body.aggs.over_time.date_histogram.fixed_interval
    ).toBe("1m");
  });

  it("keeps empty buckets, because a gap is part of the answer", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, buckets([]));

    await logHistogram(client, PATTERN, {});

    expect(firstRequest(captured).body.aggs.over_time.date_histogram.min_doc_count).toBe(0);
  });

  it("nests a breakdown under the histogram when asked", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, buckets([]));

    await logHistogram(client, PATTERN, { by: "level" });

    expect(firstRequest(captured).body.aggs.over_time.aggs.breakdown.terms).toMatchObject({
      field: "log.level",
    });
  });

  it("carries the shared filters through", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, buckets([]));

    await logHistogram(client, PATTERN, { service: "billing", since: "2h" });

    expect(firstRequest(captured).body.query.bool.filter).toContainEqual({
      terms: { "service.name": ["billing"] },
    });
  });

  it("reports the total, the peak and the span of activity", async () => {
    const { client, mock } = createMockedClient();
    capture(
      mock,
      ROUTE,
      buckets([
        ["2026-08-25T09:00:00Z", 0],
        ["2026-08-25T10:00:00Z", 12],
        ["2026-08-25T11:00:00Z", 480],
        ["2026-08-25T12:00:00Z", 0],
      ])
    );

    const text = textOf(await logHistogram(client, PATTERN, { since: "1d" }));

    expect(text).toContain("492 events over 4 buckets of 1h");
    expect(text).toContain("Peak: 480 at 2026-08-25T11:00:00Z");
    // Where it started and where it stopped: the two facts a histogram is asked
    // for, stated rather than left to be read off the rows.
    expect(text).toContain("First activity: 2026-08-25T10:00:00Z");
    expect(text).toContain("last: 2026-08-25T11:00:00Z");
    expect(text).toContain("2026-08-25T12:00:00Z  0");
  });

  it("says the window is empty rather than showing an empty table", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, ROUTE, buckets([["2026-08-25T10:00:00Z", 0]]));

    expect(textOf(await logHistogram(client, PATTERN, {}))).toContain(
      "No events in this window."
    );
  });

  it("refuses a window it cannot parse, before sending anything", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, buckets([]));

    const result = await logHistogram(client, PATTERN, { since: "last tuesday" });

    expect(isFailure(result)).toBe(true);
    expect(captured.requests).toHaveLength(0);
  });

  it("returns the failure as content rather than throwing", async () => {
    const { client, mock } = createMockedClient();
    failEveryRoute(mock);

    const result = await logHistogram(client, PATTERN, {});

    expect(hasErrorFragment(result)).toBe(true);
    expect(result.isError).toBe(true);
  });
});
