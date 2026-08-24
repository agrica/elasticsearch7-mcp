import { describe, expect, it } from "vitest";
import { search } from "../src/tools/search.js";
import {
  capture,
  createMockedClient,
  firstRequest,
  hasErrorFragment,
  textOf,
} from "./support/mockClient.js";

const MAPPING = {
  "logs-2026": {
    mappings: {
      properties: {
        message: { type: "text" },
        level: { type: "keyword" },
        title: { type: "text" },
      },
    },
  },
};

function hits(hitList: unknown[], total: unknown = { value: hitList.length, relation: "eq" }) {
  return { took: 3, timed_out: false, hits: { total, max_score: 1, hits: hitList } };
}

describe("search", () => {
  it("nests the query DSL under `body` — not at the top level", async () => {
    const { client, mock } = createMockedClient();
    mock.add({ method: "GET", path: "/logs-2026/_mapping" }, () => MAPPING);
    const search_ = capture(mock, { method: "POST", path: "/logs-2026/_search" }, hits([]));

    await search(client, "logs-2026", { size: 5, from: 10, query: { match_all: {} } });

    // The 7.x client puts the request body on the wire; if a tool passed the DSL
    // as top-level params instead, these keys would land in the querystring.
    expect(search_.requests).toHaveLength(1);
    expect(firstRequest(search_).body).toMatchObject({
      size: 5,
      from: 10,
      query: { match_all: {} },
    });
  });

  it("auto-injects highlighting for text fields only", async () => {
    const { client, mock } = createMockedClient();
    mock.add({ method: "GET", path: "/logs-2026/_mapping" }, () => MAPPING);
    const search_ = capture(mock, { method: "POST", path: "/logs-2026/_search" }, hits([]));

    await search(client, "logs-2026", { query: { match_all: {} } });

    const highlight = firstRequest(search_).body.highlight;
    expect(Object.keys(highlight.fields).sort()).toEqual(["message", "title"]);
    expect(highlight.pre_tags).toEqual(["<em>"]);
    expect(highlight.post_tags).toEqual(["</em>"]);
  });

  it("skips the highlight block when the index has no properties", async () => {
    const { client, mock } = createMockedClient();
    mock.add({ method: "GET", path: "/bare/_mapping" }, () => ({ bare: { mappings: {} } }));
    const search_ = capture(mock, { method: "POST", path: "/bare/_search" }, hits([]));

    await search(client, "bare", { query: { match_all: {} } });

    expect(firstRequest(search_).body).not.toHaveProperty("highlight");
  });

  it("reads hits through `.body` and renders highlights before plain fields", async () => {
    const { client, mock } = createMockedClient();
    mock.add({ method: "GET", path: "/logs-2026/_mapping" }, () => MAPPING);
    capture(
      mock,
      { method: "POST", path: "/logs-2026/_search" },
      hits(
        [
          {
            _index: "logs-2026",
            _id: "1",
            _source: { message: "disk full", level: "error" },
            highlight: { message: ["disk <em>full</em>"] },
          },
        ],
        { value: 137, relation: "eq" }
      )
    );

    const result = await search(client, "logs-2026", { size: 1, from: 20 });
    const text = textOf(result);

    expect(text).toContain("Total search results: 137");
    expect(text).toContain("Displaying 1 records starting from position 20");
    expect(text).toContain("message (Highlight): disk <em>full</em>");
    // level was not highlighted, so it is rendered from _source…
    expect(text).toContain('level: "error"');
    // …while message must NOT appear twice.
    expect(text).not.toContain('message: "disk full"');
  });

  it("accepts a numeric hits.total, as older clusters may report it", async () => {
    const { client, mock } = createMockedClient();
    mock.add({ method: "GET", path: "/logs-2026/_mapping" }, () => MAPPING);
    capture(mock, { method: "POST", path: "/logs-2026/_search" }, hits([], 42));

    expect(textOf(await search(client, "logs-2026", {}))).toContain("Total search results: 42");
  });

  it("returns the aggregations, which are often the whole point of the query", async () => {
    // An aggregation query commonly asks for size: 0 — no hits at all. Dropping
    // the aggregations then leaves the caller with "Total search results: 0"
    // and nothing else, which reads as "no data" rather than "here is the
    // breakdown you asked for".
    const { client, mock } = createMockedClient();
    mock.add({ method: "GET", path: "/logs-2026/_mapping" }, () => MAPPING);
    capture(mock, { method: "POST", path: "/logs-2026/_search" }, {
      ...hits([]),
      aggregations: {
        by_level: {
          buckets: [
            { key: "error", doc_count: 128 },
            { key: "warn", doc_count: 9 },
          ],
        },
      },
    });

    const text = textOf(
      await search(client, "logs-2026", {
        size: 0,
        aggs: { by_level: { terms: { field: "level" } } },
      })
    );

    expect(text).toContain("Aggregations:");
    expect(text).toContain('"key": "error"');
    expect(text).toContain('"doc_count": 128');
  });

  it("stays silent about aggregations when the response has none", async () => {
    const { client, mock } = createMockedClient();
    mock.add({ method: "GET", path: "/logs-2026/_mapping" }, () => MAPPING);
    capture(mock, { method: "POST", path: "/logs-2026/_search" }, hits([]));

    const text = textOf(await search(client, "logs-2026", { query: { match_all: {} } }));

    expect(text).not.toContain("Aggregations");
  });

  it("reports a cluster failure as an Error fragment instead of throwing", async () => {
    const { client } = createMockedClient(); // no route registered
    const result = await search(client, "missing", { query: { match_all: {} } });

    expect(hasErrorFragment(result)).toBe(true);
  });
});
