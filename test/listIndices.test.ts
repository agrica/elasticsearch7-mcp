import { describe, expect, it } from "vitest";
import { listIndices } from "../src/tools/listIndices.js";
import {
  capture,
  createMockedClient,
  firstRequest,
  hasErrorFragment,
  textOf,
} from "./support/mockClient.js";

describe("listIndices", () => {
  it("reads the `docs.count` key, not the camelCase type alias", async () => {
    // Regression test: `docsCount` exists in estypes as a type-level alias only,
    // so reading it returned undefined for every index.
    const { client, mock } = createMockedClient();
    capture(mock, { method: "GET", path: "/_cat/indices/*" }, [
      {
        index: "logs-2026",
        health: "green",
        status: "open",
        "docs.count": "1204",
        "store.size": "5242880",
      },
    ]);

    const compact = textOf(await listIndices(client));

    expect(compact).toContain("Found 1 indices");
    // The default rendering is one compact line per index — 365 daily indices
    // came to 54 KB as pretty JSON, and this tool's JSON was its only content,
    // so the size was the answer rather than optional detail.
    expect(compact).toContain("docs=1204");
    expect(compact).toContain("bytes=5242880");
    expect(compact).not.toContain('"docsCount"');

    // verbose brings the parseable form back.
    const { client: other, mock: otherMock } = createMockedClient();
    capture(otherMock, { method: "GET", path: "/_cat/indices/*" }, [
      {
        index: "logs-2026",
        health: "green",
        status: "open",
        "docs.count": "1204",
        "store.size": "5242880",
      },
    ]);
    const verbose = textOf(await listIndices(other, undefined, true));

    expect(verbose).toContain('"docsCount": "1204"');
    expect(verbose).not.toContain('"docsCount": null');
    expect(verbose).toContain('"storeSizeBytes": "5242880"');
  });

  it("defaults the pattern to `*` and forwards a caller's pattern verbatim", async () => {
    // `/_cat/indices/*` is a catch-all route here, so the assertion is on the
    // path the tool actually requested. The pattern reaches the cat API as an
    // ES wildcard — despite the tool description calling it a regex.
    const { client, mock } = createMockedClient();
    const cat = capture(mock, { method: "GET", path: "/_cat/indices/*" }, []);

    await listIndices(client);
    await listIndices(client, "log-*");

    expect(cat.requests.map((request) => request.path)).toEqual([
      "/_cat/indices/*",
      "/_cat/indices/log-*",
    ]);
  });

  it("asks the cat API for JSON", async () => {
    const { client, mock } = createMockedClient();
    const cat = capture(mock, { method: "GET", path: "/_cat/indices/*" }, []);
    await listIndices(client);
    expect(firstRequest(cat).querystring.format).toBe("json");
    // bytes=b keeps the size machine-comparable rather than "4.7gb"
    expect(firstRequest(cat).querystring.bytes).toBe("b");
  });

  it("reports a cluster failure as an Error fragment", async () => {
    const { client } = createMockedClient();
    expect(hasErrorFragment(await listIndices(client))).toBe(true);
  });
});
