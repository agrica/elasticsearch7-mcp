import { describe, expect, it } from "vitest";
import { withCancellation } from "../src/cancellable.js";
import { listIndices } from "../src/tools/listIndices.js";
import { capture, createMockedClient, textOf } from "./support/mockClient.js";

/**
 * Cancellation exists so that a client which stops listening also stops the
 * work. The MCP SDK aborts the handler's signal on `notifications/cancelled`;
 * the 7.x Elasticsearch client has no `signal` option, so the only lever is
 * `.abort()` on the request it returns.
 *
 * The risk with wrapping the client in a Proxy is that it works at the top
 * level and silently does nothing one namespace down — where most of the API
 * lives. These tests exercise both.
 */
describe("withCancellation", () => {
  it("aborts a namespaced call, which is where most of the API lives", async () => {
    const { client } = createMockedClient();
    const controller = new AbortController();
    controller.abort();

    // cat.indices, not a top-level method: the Proxy has to follow the
    // namespace or this resolves normally and cancellation is a no-op.
    await expect(
      withCancellation(client, controller.signal).cat.indices({ format: "json" })
    ).rejects.toThrow(/abort/i);
  });

  it("aborts a top-level call too", async () => {
    const { client } = createMockedClient();
    const controller = new AbortController();
    controller.abort();

    await expect(
      withCancellation(client, controller.signal).info()
    ).rejects.toThrow(/abort/i);
  });

  it("aborts a request that is already in flight", async () => {
    const { client } = createMockedClient();
    const controller = new AbortController();

    const pending = withCancellation(client, controller.signal).cat.indices({
      format: "json",
    });
    controller.abort();

    await expect(pending).rejects.toThrow(/abort/i);
  });

  it("leaves an uncancelled call completely alone", async () => {
    const { client, mock } = createMockedClient();
    // listIndices defaults `pattern` to "*", so the path carries it.
    capture(mock, { method: "GET", path: "/_cat/indices/*" }, [
      { index: "logs", "docs.count": "5", "store.size": "1024", health: "green", status: "open" },
    ]);
    const controller = new AbortController();

    // The whole tool runs through the wrapper — including the response
    // unwrapping — so this also proves the Proxy does not disturb the shape of
    // what a call returns.
    const text = textOf(await listIndices(withCancellation(client, controller.signal)));

    expect(text).toContain("logs");
    expect(text).not.toContain("Error:");
  });

  it("passes through a method whose result cannot be aborted", async () => {
    // close() returns a plain promise. Wrapping it as though it were a request
    // would throw on the missing abort().
    const { client } = createMockedClient();
    const controller = new AbortController();

    await expect(
      withCancellation(client, controller.signal).close()
    ).resolves.not.toThrow();
  });
});
