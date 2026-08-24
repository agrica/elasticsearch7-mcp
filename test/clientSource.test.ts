import { describe, expect, it } from "vitest";
import { createClientSource } from "../src/auth/clientSource.js";
import type { TokenProvider } from "../src/auth/oauth2.js";
import { capture, createMockedClient, lastAuthorization } from "./support/mockClient.js";

/** A token provider that hands out whatever the test sets next. */
function fixedTokens(tokens: string[]): TokenProvider & { requests: number } {
  const state = {
    requests: 0,
    async access() {
      const token = tokens[Math.min(state.requests, tokens.length - 1)];
      state.requests += 1;
      return token as string;
    },
  };
  return state;
}

describe("createClientSource", () => {
  it("hands back the base client untouched when there is no OAuth2", async () => {
    const { client } = createMockedClient();
    const source = createClientSource(client);

    expect(await source()).toBe(client);
    expect(await source()).toBe(client);
  });

  it("reuses one child per token, and builds a new one on rotation", async () => {
    const { client } = createMockedClient();
    const tokens = fixedTokens(["tok-1", "tok-1", "tok-2"]);
    const source = createClientSource(client, tokens);

    const first = await source();
    const second = await source();
    const third = await source();

    // Same token, same child: a child per call would allocate a transport per
    // request for no benefit.
    expect(second).toBe(first);
    expect(third).not.toBe(first);
    expect(first).not.toBe(client);
  });

  it("puts the token in the Authorization header of every request", async () => {
    const { client, mock, sentHeaders } = createMockedClient();
    capture(mock, { method: "GET", path: "/_cat/indices/*" }, []);
    const source = createClientSource(client, fixedTokens(["tok-1"]));

    await (await source()).cat.indices({ format: "json", index: "*" });

    expect(lastAuthorization(sentHeaders)).toBe("Bearer tok-1");
  });

  it("lets the bearer win over an API key on the base client", async () => {
    // The child shares the parent's connection pool, whose connections carry the
    // parent's own auth header. The design depends on the request-level header
    // beating it — Transport.js:390 then Connection.js:261 — so this is the
    // assertion that fails if that precedence ever changes.
    const { client, mock, sentHeaders } = createMockedClient({
      auth: { apiKey: "base-key" },
    });
    capture(mock, { method: "GET", path: "/_cat/indices/*" }, []);
    const source = createClientSource(client, fixedTokens(["tok-1"]));

    await (await source()).cat.indices({ format: "json", index: "*" });

    expect(lastAuthorization(sentHeaders)).toBe("Bearer tok-1");
  });

  it("costs no extra round trip on rotation: the child skips the product check", async () => {
    // `child()` copies the product-check symbol, so a rotation does not repeat
    // the `GET /` the 7.x client uses to validate the cluster. That is the fact
    // the whole injection point rests on.
    const { client, mock } = createMockedClient();
    const root = capture(mock, { method: "GET", path: "/" }, {
      name: "es-node-1",
      cluster_name: "logging-cluster",
      cluster_uuid: "AAAAAAAAAAAAAAAAAAAAAA",
      version: { number: "7.8.0", build_flavor: "default", lucene_version: "8.5.1" },
      tagline: "You Know, for Search",
    });
    capture(mock, { method: "GET", path: "/_cat/indices/*" }, []);

    const source = createClientSource(client, fixedTokens(["tok-1", "tok-2"]));
    await (await source()).cat.indices({ format: "json", index: "*" });
    const before = root.requests.length;

    await (await source()).cat.indices({ format: "json", index: "*" });

    expect(root.requests.length, "a rotation must not re-run the product check").toBe(before);
  });

  it("asks the provider on every call, so an expired token is renewed", async () => {
    const { client } = createMockedClient();
    const tokens = fixedTokens(["tok-1"]);
    const source = createClientSource(client, tokens);

    await source();
    await source();

    // Caching the token is the provider's job, not this module's: it holds the
    // expiry, and duplicating that here would give two places to get it wrong.
    expect(tokens.requests).toBe(2);
  });
});
