import { describe, expect, it } from "vitest";
import {
  deleteByQuery,
  deleteDocument,
  deleteIndex,
} from "../src/tools/destructive.js";
import {
  capture,
  createMockedClient,
  failEveryRoute,
  firstRequest,
  hasErrorFragment,
  textOf,
} from "./support/mockClient.js";

describe("destructive guardrails", () => {
  // The environment variable says "deleting is allowed here". It does not say
  // "delete whatever a pattern matches", so these refusals apply even when the
  // tools are registered.
  const dangerous = ["logs-*", "log?-2026", "logs-a,logs-b", "_all", "*"];

  it.each(dangerous)("delete_index refuses %s without calling the cluster", async (target) => {
    const { client, mock } = createMockedClient();
    const call = capture(mock, { method: "DELETE", path: "/*" }, { acknowledged: true });

    const result = await deleteIndex(client, target);

    expect(hasErrorFragment(result)).toBe(true);
    expect(call.requests, "no request may reach the cluster").toHaveLength(0);
  });

  it.each(dangerous)("delete_by_query refuses %s without calling the cluster", async (target) => {
    const { client, mock } = createMockedClient();
    const call = capture(mock, { method: "POST", path: "/*" }, { deleted: 0 });

    const result = await deleteByQuery(client, target, { match_all: {} });

    expect(hasErrorFragment(result)).toBe(true);
    expect(call.requests).toHaveLength(0);
  });

  it("deletes a concrete index and says the documents went with it", async () => {
    const { client, mock } = createMockedClient();
    const call = capture(mock, { method: "DELETE", path: "/logs-2026" }, { acknowledged: true });

    const text = textOf(await deleteIndex(client, "logs-2026"));

    expect(firstRequest(call).path).toBe("/logs-2026");
    expect(text).toContain("deleted");
    expect(text).toContain("every document it held");
  });

  it("reports a cluster failure rather than throwing", async () => {
    const { client, mock } = createMockedClient();
    failEveryRoute(mock);
    expect(hasErrorFragment(await deleteIndex(client, "logs-2026"))).toBe(true);
  });
});

describe("delete_document", () => {
  it("refreshes so the deletion is immediately visible", async () => {
    const { client, mock } = createMockedClient();
    const call = capture(mock, { method: "DELETE", path: "/logs/_doc/a1" }, { result: "deleted" });

    const text = textOf(await deleteDocument(client, "logs", "a1"));

    expect(firstRequest(call).querystring.refresh).toBe("true");
    expect(text).toContain('Document "a1" deleted');
  });

  it("treats an absent document as an answer, not a failure", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, { method: "DELETE", path: "/logs/_doc/ghost" }, { result: "not_found" });

    const result = await deleteDocument(client, "logs", "ghost");

    expect(hasErrorFragment(result)).toBe(false);
    expect(textOf(result)).toContain("does not exist");
  });
});

describe("delete_by_query", () => {
  it("sends the query in the body and reports what it removed", async () => {
    const { client, mock } = createMockedClient();
    const call = capture(mock, { method: "POST", path: "/logs/_delete_by_query" }, {
      took: 12,
      deleted: 7,
      total: 9,
      version_conflicts: 2,
      failures: [],
    });

    const text = textOf(
      await deleteByQuery(client, "logs", { term: { level: "debug" } })
    );

    expect(firstRequest(call).body).toEqual({ query: { term: { level: "debug" } } });
    expect(firstRequest(call).querystring.refresh).toBe("true");
    expect(text).toContain("Deleted 7 of 9");
    // Version conflicts are silent data left behind: say so.
    expect(text).toContain("2 version conflicts");
  });
});
