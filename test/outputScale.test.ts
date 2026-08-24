import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_RESULT_BYTES } from "../src/outputBudget.js";
import { listIndices } from "../src/tools/listIndices.js";
import { listNodes, listShards } from "../src/tools/diagnostics.js";
import { search } from "../src/tools/search.js";
import { getMappings } from "../src/tools/getMappings.js";
import { searchLogs } from "../src/tools/ecs/searchLogs.js";
import { logHistogram } from "../src/tools/ecs/logHistogram.js";
import { capture, createMockedClient, textOf } from "./support/mockClient.js";
import {
  dailyIndices,
  ecsLogHits,
  logHits,
  nodesFor,
  resultBytes,
  shardsFor,
  textBytes,
} from "./support/scaleFixtures.js";

/**
 * The regression guard for the finding that drove this work.
 *
 * Before the output budget, these exact fixtures produced 385 469 bytes from
 * `list_shards`, 127 716 from a `size: 500` search and 54 405 from
 * `list_indices` — while the whole `tools/list` payload the project rations is
 * 15 871. The tool list was budgeted and the tool output was not.
 *
 * These tests exist so that stops being true only deliberately.
 */
const CEILING = DEFAULT_MAX_RESULT_BYTES;

describe("output at cluster scale", () => {
  it("keeps list_indices under budget for a year of daily indices", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, { method: "GET", path: "/_cat/indices/*" }, dailyIndices());

    const result = await listIndices(client);
    const text = textOf(result);

    expect(resultBytes(result)).toBeLessThanOrEqual(CEILING + 300);
    expect(text).toContain("Found 365 indices");
  });

  it("keeps list_shards under budget for 2190 shards, verbose or not", async () => {
    const shards = shardsFor(dailyIndices());
    expect(shards).toHaveLength(2190);

    for (const verbose of [false, true]) {
      const { client, mock } = createMockedClient();
      capture(mock, { method: "GET", path: "/_cat/shards" }, shards);

      const result = await listShards(client, undefined, verbose);

      expect(
        resultBytes(result),
        `verbose=${verbose} must stay within the budget`
      ).toBeLessThanOrEqual(CEILING + 300);
      expect(textOf(result)).toContain("2190 shards");
    }
  });

  it("tells the caller what it dropped, and how to ask for less", async () => {
    // The whole point: a trimmed answer that does not say it was trimmed makes
    // a model conclude the missing entry does not exist.
    const { client, mock } = createMockedClient();
    capture(mock, { method: "GET", path: "/_cat/shards" }, shardsFor(dailyIndices()));

    const text = textOf(await listShards(client, undefined, true));

    expect(text).toContain("Result budget");
    expect(text).toContain("Pass an index");
  });

  it("returns as much verbose detail as fits, not none of it", async () => {
    // The first attempt emitted the dump as one fragment, so the budget dropped
    // it whole: `verbose` answered with 145 bytes — a summary and an apology —
    // where the caller had explicitly asked for detail. Chunking makes the trim
    // partial instead of total.
    const { client, mock } = createMockedClient();
    capture(mock, { method: "GET", path: "/_cat/shards" }, shardsFor(dailyIndices()));

    const result = await listShards(client, undefined, true);
    const text = textOf(result);

    // Measured on the text alone, which is what a `verbose` caller asked for:
    // the structured payload gets what the text left, never the other way
    // round, so adding an output schema cannot shrink this.
    expect(textBytes(result)).toBeGreaterThan(10_000);
    expect(resultBytes(result)).toBeLessThanOrEqual(CEILING + 300);
    // Each chunk says which slice of the whole it is, so a caller can tell how
    // far the listing got.
    expect(text).toMatch(/\[1–50 of 2190\]/);
    expect(text).toContain("detail sections omitted");
  });

  it("clamps a search asking for 500 hits, and says where to page from", async () => {
    const { client, mock } = createMockedClient();
    mock.add({ method: "GET", path: "/logs/_mapping" }, () => ({
      logs: { mappings: { properties: { message: { type: "text" } } } },
    }));
    capture(mock, { method: ["GET", "POST"], path: "/logs/_search" }, {
      took: 12,
      hits: { total: { value: 98_421, relation: "eq" }, max_score: 1, hits: logHits(500) },
    });

    const result = await search(client, "logs", { size: 500 });
    const text = textOf(result);

    expect(text).toContain("clamped to 100");
    expect(text).toContain("from=100");
    expect(resultBytes(result)).toBeLessThanOrEqual(CEILING + 300);
  });

  it("does not shrink the text answer to make room for the structured one", async () => {
    // The first version of the structured payload took half the budget up
    // front, and the text answer went from listing all 365 indices to listing
    // about half — the same five facts cost roughly twice as much as JSON as
    // they do as a line. The text is what the calling model reads, so it is
    // assembled first and the structured copy gets the remainder.
    const { client, mock } = createMockedClient();
    const indices = dailyIndices();
    capture(mock, { method: "GET", path: "/_cat/indices/*" }, indices);

    const result = await listIndices(client);
    const text = textOf(result);

    expect(text).not.toContain("Result budget");
    for (const index of [indices[0], indices[indices.length - 1]]) {
      expect(text).toContain(index?.index);
    }
    expect(resultBytes(result)).toBeLessThanOrEqual(CEILING + 300);
  });

  it("keeps the structured payload as terse as the text it accompanies", async () => {
    // `list_shards` without verbose answers in 26 bytes. Letting the structured
    // payload fill the remaining budget with 2190 STARTED rows nobody asked for
    // turned that into 32 KB — measured, on the first version of this change.
    const { client, mock } = createMockedClient();
    capture(mock, { method: "GET", path: "/_cat/shards" }, shardsFor(dailyIndices()));

    const result = await listShards(client);

    expect(resultBytes(result)).toBeLessThan(1_000);
    expect(result.structuredContent).toMatchObject({ total: 2190, returned: 0 });
  });

  it("charges the structured payload against the same budget as the text", async () => {
    // Adding `structuredContent` is how a byte budget gets quietly halved: the
    // fragments look the same size while the result carries a second copy of
    // the answer. Both halves are measured, and their sum is what must hold.
    const { client, mock } = createMockedClient();
    capture(mock, { method: "GET", path: "/_cat/shards" }, shardsFor(dailyIndices()));

    const result = await listShards(client, undefined, true);
    const structured = result.structuredContent as {
      total: number;
      returned: number;
      omitted: number;
      shards: unknown[];
    };

    expect(structured.total).toBe(2190);
    expect(structured.shards.length).toBe(structured.returned);
    // Trimmed, and saying so in a number rather than only in prose.
    expect(structured.returned).toBeLessThan(structured.total);
    expect(structured.omitted).toBe(structured.total - structured.returned);
    expect(resultBytes(result)).toBeLessThanOrEqual(CEILING + 300);
  });

  it("keeps get_mappings bounded on a mapping with a thousand fields", async () => {
    // This tool was never in the measured set, and it returned the whole
    // mapping pretty-printed with no budget at all.
    const { client, mock } = createMockedClient();
    const properties = Object.fromEntries(
      Array.from({ length: 1000 }, (_, i) => [
        `field_${i}`,
        { type: i % 3 === 0 ? "text" : "keyword" },
      ])
    );
    capture(mock, { method: "GET", path: "/logs/_mapping" }, {
      logs: { mappings: { properties } },
    });

    const result = await getMappings(client, "logs");

    expect(textOf(result)).toContain("1000 fields");
    expect(resultBytes(result)).toBeLessThanOrEqual(CEILING + 300);
  });

  it("keeps search_logs under budget on 500 ECS events", async () => {
    const { client, mock } = createMockedClient();
    const hits = ecsLogHits(500);
    capture(mock, { method: "POST", path: "/logs-app-*/_search" }, {
      took: 12,
      hits: { total: { value: 240_000, relation: "eq" }, hits },
    });

    // The tool clamps to 100 before the budget ever sees the result — a clamp is
    // visible in the reported count, where a trimmed tail leaves the caller
    // guessing where it stopped.
    const result = await searchLogs(client, "logs-app-*", { limit: 500 });

    expect(resultBytes(result)).toBeLessThanOrEqual(CEILING + 300);
    expect(textOf(result)).toContain("240000 matching events");
  });

  it("does not pay for the stack trace unless it will be printed", async () => {
    const { client, mock } = createMockedClient();
    // Twenty, not a hundred: both results have to stay clear of the ceiling for
    // the comparison to measure the stack trace rather than the budget.
    const hits = ecsLogHits(20);
    const route = { method: "POST", path: "/logs-app-*/_search" };

    // The mock returns the same documents either way, so this measures what the
    // *rendering* costs — the request-side saving is asserted in
    // test/searchLogs.test.ts, where `_source` is inspected.
    const quiet = capture(mock, route, {
      took: 12,
      hits: { total: { value: 20, relation: "eq" }, hits },
    });
    const plain = await searchLogs(client, "logs-app-*", {});
    const verbose = await searchLogs(client, "logs-app-*", { verbose: true });

    expect(quiet.requests).toHaveLength(2);
    expect(resultBytes(plain)).toBeLessThan(CEILING);
    expect(resultBytes(verbose)).toBeLessThan(CEILING);
    // The stack trace is the largest field in an ECS error document: printing it
    // more than doubles the answer, which is why it is opt-in on both the
    // request and the rendering.
    expect(resultBytes(verbose)).toBeGreaterThan(resultBytes(plain) * 2);
  });

  it("keeps a histogram bounded when the caller asks for a minute over a month", async () => {
    const { client, mock } = createMockedClient();
    // 43 200 buckets: what a 1m interval over 30 days produces. The derived
    // interval would have been 1d, so this is the deliberate-override path.
    const buckets = Array.from({ length: 43_200 }, (_, i) => ({
      key_as_string: `2026-08-25T${String(i % 24).padStart(2, "0")}:00:00.000Z`,
      key: i,
      doc_count: i % 7,
    }));
    capture(mock, { method: "POST", path: "/logs-app-*/_search" }, {
      took: 30,
      hits: { total: { value: 0, relation: "eq" }, hits: [] },
      aggregations: { over_time: { buckets } },
    });

    const result = await logHistogram(client, "logs-app-*", {
      since: "30d",
      interval: "1m",
    });

    expect(resultBytes(result)).toBeLessThanOrEqual(CEILING + 300);
    // And the trim is announced, so a model does not read the shortened series
    // as the whole window.
    expect(textOf(result)).toMatch(/omitted|not shown|interval/i);
  });

  it("leaves list_nodes alone, because nodes were never the hazard", async () => {
    // 24 nodes, not 2190 shards. The budget applies as a backstop and should
    // not be trimming anything here — if it is, the fixture or the ceiling is
    // wrong, and a silent trim on a small cluster would be a real bug.
    const { client, mock } = createMockedClient();
    capture(mock, { method: "GET", path: "/_cat/nodes" }, nodesFor());

    const text = textOf(await listNodes(client));

    expect(text).toContain("24 nodes");
    expect(text).not.toContain("Result budget");
  });
});
