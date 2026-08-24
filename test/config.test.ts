import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, createClientOptions, loadConfigFromEnv } from "../src/config/schema.js";

describe("createClientOptions", () => {
  it("maps every URL onto `nodes` for failover and load balancing", () => {
    const options = createClientOptions({
      urls: ["http://a:9200", "http://b:9200"],
    });

    expect(options.nodes).toEqual(["http://a:9200", "http://b:9200"]);
  });

  it("prefers an API key over basic auth when both are present", () => {
    const options = createClientOptions({
      urls: ["http://a:9200"],
      apiKey: "secret-key",
      username: "elastic",
      password: "hunter2",
    });

    expect(options.auth).toEqual({ apiKey: "secret-key" });
  });

  it("uses basic auth only when username AND password are both non-empty", () => {
    const both = createClientOptions({
      urls: ["http://a:9200"],
      username: "elastic",
      password: "hunter2",
    });
    expect(both.auth).toEqual({ username: "elastic", password: "hunter2" });

    // This guard is what neutralises Windows' always-present USERNAME variable:
    // a username with no password must not produce an auth block.
    const usernameOnly = createClientOptions({
      urls: ["http://a:9200"],
      username: "jmori",
      password: "",
    });
    expect(usernameOnly.auth).toBeUndefined();
  });

  it("leaves the base client with no auth at all when OAuth2 is configured", () => {
    // The safety property: if the bearer path breaks, the request must fail with
    // a 401 rather than quietly succeeding as whatever identity ES_API_KEY
    // names. A silent substitution of identity is worse than an outage.
    const options = createClientOptions({
      urls: ["http://a:9200"],
      apiKey: "secret-key",
      username: "elastic",
      password: "hunter2",
      oauth: {
        tokenUrl: "https://idp.example.test/token",
        clientId: "mcp",
        clientSecret: "s3cr3t",
      },
    });

    expect(options.auth).toBeUndefined();
  });

  it("refuses a token endpoint that would send the secret in the clear", () => {
    const insecure = () =>
      createClientOptions({
        urls: ["http://a:9200"],
        oauth: {
          tokenUrl: "http://idp.example.test/token",
          clientId: "mcp",
          clientSecret: "s3cr3t",
        },
      });

    expect(insecure).toThrow(/https/i);
  });

  it("allows a loopback token endpoint over plain HTTP, for local providers", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      const options = createClientOptions({
        urls: ["http://a:9200"],
        oauth: {
          tokenUrl: `http://${host}:8080/token`,
          clientId: "mcp",
          clientSecret: "s3cr3t",
        },
      });

      expect(options.auth, `${host} must be accepted`).toBeUndefined();
    }
  });

  it("refuses a half-configured OAuth2 block instead of falling back", () => {
    // The whole point: an operator who forgot the secret must be told, not
    // silently connected as the API key identity.
    const partial = () =>
      createClientOptions({
        urls: ["http://a:9200"],
        apiKey: "secret-key",
        oauth: {
          tokenUrl: "https://idp.example.test/token",
          clientId: "mcp",
          clientSecret: "",
        },
      });

    expect(partial).toThrow(/ES_OAUTH_CLIENT_SECRET/);
  });

  it("defaults the client authentication style to post", () => {
    const { oauth } = ConfigSchema.parse({
      urls: ["http://a:9200"],
      oauth: {
        tokenUrl: "https://idp.example.test/token",
        clientId: "mcp",
        clientSecret: "s3cr3t",
      },
    });

    expect(oauth?.authStyle).toBe("post");
  });

  it("refuses an authentication style that is neither post nor basic", () => {
    expect(() =>
      ConfigSchema.parse({
        urls: ["http://a:9200"],
        oauth: {
          tokenUrl: "https://idp.example.test/token",
          clientId: "mcp",
          clientSecret: "s3cr3t",
          authStyle: "jwt" as "post",
        },
      })
    ).toThrow();
  });

  it("reads a CA certificate into the `ssl` option — the 7.x name, not `tls`", () => {
    // Regression test: the 8.x client called this option `tls`, so keeping that
    // name here would silently disable certificate verification.
    const dir = mkdtempSync(join(tmpdir(), "es-mcp-ca-"));
    const caPath = join(dir, "ca.crt");
    writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nnot a real cert\n");

    const options = createClientOptions({ urls: ["https://a:9200"], caCert: caPath });

    expect(options.ssl?.ca).toBeInstanceOf(Buffer);
    expect(String(options.ssl?.ca)).toContain("BEGIN CERTIFICATE");
    expect(options).not.toHaveProperty("tls");
  });

  it("survives an unreadable certificate path rather than crashing the server", () => {
    const options = createClientOptions({
      urls: ["https://a:9200"],
      caCert: join(tmpdir(), "definitely-absent-ca.crt"),
    });

    expect(options.ssl).toBeUndefined();
    expect(options.nodes).toEqual(["https://a:9200"]);
  });

  it("rejects a malformed URL, which is how a bad ES_HOST surfaces at startup", () => {
    expect(() => createClientOptions({ urls: ["not-a-url"] })).toThrow();
    expect(() => createClientOptions({ urls: [""] })).toThrow();
  });
});

describe("loadConfigFromEnv", () => {
  const KEYS = [
    "ES_HOST", "HOST",
    "ES_API_KEY", "API_KEY",
    "ES_USERNAME", "USERNAME",
    "ES_PASSWORD", "PASSWORD",
    "ES_CA_CERT", "CA_CERT",
    "ES_ADMIN_TOOLS", "ADMIN_TOOLS",
    "ES_ALLOW_DESTRUCTIVE", "ALLOW_DESTRUCTIVE",
    "ES_OAUTH_TOKEN_URL", "OAUTH_TOKEN_URL",
    "ES_OAUTH_CLIENT_ID", "OAUTH_CLIENT_ID", "CLIENT_ID",
    "ES_OAUTH_CLIENT_SECRET", "OAUTH_CLIENT_SECRET", "CLIENT_SECRET",
    "ES_OAUTH_CLIENT_SECRET_FILE",
    "ES_OAUTH_SCOPE", "SCOPE",
    "ES_OAUTH_AUDIENCE", "AUDIENCE",
    "ES_OAUTH_AUTH_STYLE",
  ];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    for (const key of KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("splits a comma-separated ES_HOST into several nodes, trimming blanks", () => {
    process.env.ES_HOST = " http://a:9200 , http://b:9200 ,, ";

    expect(loadConfigFromEnv().urls).toEqual(["http://a:9200", "http://b:9200"]);
  });

  it("falls back to the legacy un-prefixed variables", () => {
    process.env.HOST = "http://legacy:9200";
    process.env.API_KEY = "legacy-key";

    const config = loadConfigFromEnv();

    expect(config.urls).toEqual(["http://legacy:9200"]);
    expect(config.apiKey).toBe("legacy-key");
  });

  it("lets the ES_-prefixed variables win over the legacy ones", () => {
    process.env.ES_HOST = "http://new:9200";
    process.env.HOST = "http://legacy:9200";

    expect(loadConfigFromEnv().urls).toEqual(["http://new:9200"]);
  });

  it.each([
    ["true", true],
    ["1", true],
    ["TRUE", true],
    ["  true  ", true],
    ["yes", false],
    ["on", false],
    ["false", false],
    ["0", false],
    ["", false],
  ])("reads ES_ADMIN_TOOLS=%j as %s", (value, expected) => {
    process.env.ES_ADMIN_TOOLS = value;

    expect(loadConfigFromEnv().adminTools).toBe(expected);
  });

  it("leaves both gates closed when neither variable is set", () => {
    const config = loadConfigFromEnv();

    expect(config.adminTools).toBe(false);
    expect(config.allowDestructive).toBe(false);
  });

  it("opens the destructive gate on ES_ALLOW_DESTRUCTIVE alone", () => {
    // The two gates are independent: staging may want the deletes without the
    // diagnostics.
    process.env.ES_ALLOW_DESTRUCTIVE = "true";
    const config = loadConfigFromEnv();

    expect(config.allowDestructive).toBe(true);
    expect(config.adminTools).toBe(false);
  });

  it("ignores un-prefixed ADMIN_TOOLS and ALLOW_DESTRUCTIVE", () => {
    // Deliberately no legacy fallback here, unlike the connection variables:
    // an ambient ADMIN_TOOLS deciding whether deletes are reachable is the
    // USERNAME hazard with worse consequences.
    process.env.ADMIN_TOOLS = "true";
    process.env.ALLOW_DESTRUCTIVE = "true";
    const config = loadConfigFromEnv();

    expect(config.adminTools).toBe(false);
    expect(config.allowDestructive).toBe(false);
  });

  it("reads the OAuth2 block, trimming a secret pasted with a newline", () => {
    // Claude Code warns about exactly this: a token pasted into an mcpServers
    // block arrives with a trailing newline. Untrimmed it yields
    // `invalid_client`, an error that says nothing about its cause.
    process.env.ES_HOST = "https://gateway:9200";
    process.env.ES_OAUTH_TOKEN_URL = " https://idp.example.test/token ";
    process.env.ES_OAUTH_CLIENT_ID = " mcp-elasticsearch ";
    process.env.ES_OAUTH_CLIENT_SECRET = "s3cr3t\n";
    process.env.ES_OAUTH_SCOPE = " es:read ";

    const config = loadConfigFromEnv();

    expect(config.oauth).toMatchObject({
      tokenUrl: "https://idp.example.test/token",
      clientId: "mcp-elasticsearch",
      clientSecret: "s3cr3t",
      scope: "es:read",
    });
  });

  it("reads the secret from a file, newline included", () => {
    const directory = mkdtempSync(join(tmpdir(), "es-mcp-oauth-"));
    const file = join(directory, "secret");
    writeFileSync(file, "file-secret\n");

    process.env.ES_HOST = "https://gateway:9200";
    process.env.ES_OAUTH_TOKEN_URL = "https://idp.example.test/token";
    process.env.ES_OAUTH_CLIENT_ID = "mcp";
    process.env.ES_OAUTH_CLIENT_SECRET_FILE = file;

    expect(loadConfigFromEnv().oauth?.clientSecret).toBe("file-secret");
  });

  it("refuses to start when the secret file cannot be read", () => {
    // An unreachable credential must stop the server, not start a session that
    // cannot authenticate and cannot say why.
    process.env.ES_HOST = "https://gateway:9200";
    process.env.ES_OAUTH_TOKEN_URL = "https://idp.example.test/token";
    process.env.ES_OAUTH_CLIENT_ID = "mcp";
    process.env.ES_OAUTH_CLIENT_SECRET_FILE = join(tmpdir(), "no-such-secret-file");

    expect(() => loadConfigFromEnv()).toThrow(/ES_OAUTH_CLIENT_SECRET_FILE/);
  });

  it("builds the block from any single OAuth2 variable, so a gap is reported", () => {
    // Reading it only when the token URL is present would let
    // ES_OAUTH_CLIENT_ID alone be ignored in silence — a partial configuration
    // that downgrades to another factor without a word.
    process.env.ES_HOST = "https://gateway:9200";
    process.env.ES_OAUTH_CLIENT_ID = "mcp";

    const config = loadConfigFromEnv();

    expect(config.oauth).toBeDefined();
    expect(() => ConfigSchema.parse(config)).toThrow(/ES_OAUTH_TOKEN_URL/);
  });

  it("leaves the OAuth2 block absent when no variable is set", () => {
    process.env.ES_HOST = "https://gateway:9200";

    expect(loadConfigFromEnv().oauth).toBeUndefined();
  });

  it("ignores un-prefixed OAuth2 variables entirely", () => {
    // The USERNAME hazard, with worse consequences: an ambient CLIENT_SECRET
    // must never decide which identity this server presents.
    process.env.ES_HOST = "https://gateway:9200";
    process.env.CLIENT_ID = "ambient";
    process.env.CLIENT_SECRET = "ambient-secret";
    process.env.SCOPE = "ambient-scope";

    expect(loadConfigFromEnv().oauth).toBeUndefined();
  });

  it("produces an invalid config when ES_HOST is unset, failing at startup", () => {
    const config = loadConfigFromEnv();

    expect(config.urls).toEqual([""]);
    expect(() => createClientOptions(config)).toThrow();
  });
});
