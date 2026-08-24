import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTokenProvider, type OAuthConfig } from "../src/auth/oauth2.js";

/**
 * The token provider, against a stubbed `fetch`.
 *
 * No clock is faked: the provider takes its `now` as an argument precisely so a
 * test can move time without touching the global timers, which the abort signals
 * elsewhere in this suite depend on.
 */
const CONFIG: OAuthConfig = {
  tokenUrl: "https://idp.example.test/token",
  clientId: "mcp-elasticsearch",
  clientSecret: "s3cr3t",
  authStyle: "post",
};

type Stub = {
  calls: { url: string; init: RequestInit }[];
  reply: (body: unknown, status?: number) => void;
};

function stubFetch(): Stub {
  const calls: Stub["calls"] = [];
  let next: { body: unknown; status: number } = { body: {}, status: 200 };

  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  });

  return {
    calls,
    reply: (body, status = 200) => {
      next = { body, status };
    },
  };
}

/** The body of a captured token request, as parsed form parameters. */
function formOf(call: { init: RequestInit }): URLSearchParams {
  return new URLSearchParams(String(call.init.body));
}

let stub: Stub;

beforeEach(() => {
  stub = stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createTokenProvider", () => {
  it("asks for a client_credentials token and returns it", async () => {
    stub.reply({ access_token: "tok-1", token_type: "Bearer", expires_in: 3600 });

    const provider = createTokenProvider(CONFIG);

    expect(await provider.access()).toBe("tok-1");
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.url).toBe(CONFIG.tokenUrl);
    expect(formOf(stub.calls[0]!).get("grant_type")).toBe("client_credentials");
  });

  it("reuses the cached token until the renewal margin", async () => {
    stub.reply({ access_token: "tok-1", expires_in: 3600 });

    let clock = 1_000_000;
    const provider = createTokenProvider(CONFIG, () => clock);

    expect(await provider.access()).toBe("tok-1");

    // Well inside the lifetime: no second request.
    clock += 3_000_000;
    expect(await provider.access()).toBe("tok-1");
    expect(stub.calls).toHaveLength(1);

    // Past expiry minus the 60s margin.
    stub.reply({ access_token: "tok-2", expires_in: 3600 });
    clock += 600_000;
    expect(await provider.access()).toBe("tok-2");
    expect(stub.calls).toHaveLength(2);
  });

  it("keeps a 30-second token usable, rather than permanently expired", async () => {
    // A flat 60s margin would put the expiry in the past the moment the token
    // arrived, so every call would fetch a new one.
    stub.reply({ access_token: "short", expires_in: 30 });

    let clock = 0;
    const provider = createTokenProvider(CONFIG, () => clock);

    expect(await provider.access()).toBe("short");
    clock += 10_000;
    expect(await provider.access()).toBe("short");
    expect(stub.calls).toHaveLength(1);
  });

  it("fetches once for concurrent callers", async () => {
    stub.reply({ access_token: "tok-1", expires_in: 3600 });

    const provider = createTokenProvider(CONFIG);
    const tokens = await Promise.all([
      provider.access(),
      provider.access(),
      provider.access(),
    ]);

    expect(tokens).toEqual(["tok-1", "tok-1", "tok-1"]);
    expect(stub.calls, "concurrent calls must share one token request").toHaveLength(1);
  });

  it("sends the credentials in the body for post, in a header for basic", async () => {
    stub.reply({ access_token: "tok", expires_in: 60 });
    await createTokenProvider(CONFIG).access();

    const posted = formOf(stub.calls[0]!);
    expect(posted.get("client_id")).toBe("mcp-elasticsearch");
    expect(posted.get("client_secret")).toBe("s3cr3t");
    expect((stub.calls[0]?.init.headers as Record<string, string>).authorization).toBeUndefined();

    stub.reply({ access_token: "tok", expires_in: 60 });
    await createTokenProvider({ ...CONFIG, authStyle: "basic" }).access();

    const headers = stub.calls[1]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from("mcp-elasticsearch:s3cr3t").toString("base64")}`
    );
    expect(formOf(stub.calls[1]!).get("client_secret")).toBeNull();
  });

  it("passes scope and audience only when configured", async () => {
    stub.reply({ access_token: "tok", expires_in: 60 });
    await createTokenProvider({
      ...CONFIG,
      scope: "es:read",
      audience: "https://es.example.test",
    }).access();

    const body = formOf(stub.calls[0]!);
    expect(body.get("scope")).toBe("es:read");
    expect(body.get("audience")).toBe("https://es.example.test");

    stub.reply({ access_token: "tok", expires_in: 60 });
    await createTokenProvider(CONFIG).access();
    expect(formOf(stub.calls[1]!).has("scope")).toBe(false);
    expect(formOf(stub.calls[1]!).has("audience")).toBe(false);
  });

  it("assumes a short lifetime when expires_in is absent, and says so once", async () => {
    const warnings: string[] = [];
    vi.spyOn(console, "error").mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });

    stub.reply({ access_token: "tok-1" });

    let clock = 0;
    const provider = createTokenProvider(CONFIG, () => clock);

    await provider.access();
    // 300s assumed, 60s margin: still valid at 200s, renewed past 240s.
    clock += 200_000;
    await provider.access();
    expect(stub.calls).toHaveLength(1);

    stub.reply({ access_token: "tok-2" });
    clock += 60_000;
    expect(await provider.access()).toBe("tok-2");

    expect(warnings.filter((line) => line.includes("no expires_in"))).toHaveLength(1);
  });

  it("refuses a token that is not a bearer", async () => {
    stub.reply({ access_token: "tok", token_type: "mac", expires_in: 60 });

    await expect(createTokenProvider(CONFIG).access()).rejects.toThrow(/only bearer/i);
  });

  it("refuses a response with no access_token", async () => {
    stub.reply({ expires_in: 60 });

    await expect(createTokenProvider(CONFIG).access()).rejects.toThrow(/no access_token/i);
  });

  it("reports the provider's error fields, and nothing else of the body", async () => {
    // Several identity providers echo the request back in an error. If any of
    // that reached the message, the client secret would travel into a tool
    // result — which is to say into the calling model's context.
    stub.reply(
      {
        error: "invalid_client",
        error_description: "client authentication failed",
        request: { client_secret: "s3cr3t", client_id: "mcp-elasticsearch" },
      },
      401
    );

    const failure = await createTokenProvider(CONFIG)
      .access()
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));

    expect(failure).toContain("401");
    expect(failure).toContain("invalid_client");
    expect(failure).toContain("client authentication failed");
    expect(failure, "the secret must never appear in an error message").not.toContain("s3cr3t");
  });

  it("never puts the token or the secret in a log line", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((message: unknown) => {
      logged.push(String(message));
    });

    stub.reply({ access_token: "tok-secret-value" });
    await createTokenProvider(CONFIG).access();

    const all = logged.join("\n");
    expect(all).not.toContain("tok-secret-value");
    expect(all).not.toContain("s3cr3t");
  });

  it("retries the request after a failure instead of caching it", async () => {
    stub.reply({ error: "temporarily_unavailable" }, 503);
    const provider = createTokenProvider(CONFIG);
    await expect(provider.access()).rejects.toThrow(/503/);

    stub.reply({ access_token: "tok-1", expires_in: 60 });
    expect(await provider.access()).toBe("tok-1");
    expect(stub.calls).toHaveLength(2);
  });
});
