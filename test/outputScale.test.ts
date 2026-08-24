import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_RESULT_BYTES } from "../src/outputBudget.js";
import { listIndices } from "../src/tools/listIndices.js";
import { listNodes, listShards } from "../src/tools/diagnostics.js";
import { search } from "../src/tools/search.js";
import { capture, createMockedClient, textOf } from "./support/mockClient.js";
import {
  dailyIndices,
  logHits,
  nodesFor,
  resultBytes,
  shardsFor,
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

    expect(resultBytes(result)).toBeGreaterThan(10_000);
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
