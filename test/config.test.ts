import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClientOptions, loadConfigFromEnv } from "../src/config/schema.js";

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

  it("produces an invalid config when ES_HOST is unset, failing at startup", () => {
    const config = loadConfigFromEnv();

    expect(config.urls).toEqual([""]);
    expect(() => createClientOptions(config)).toThrow();
  });
});
