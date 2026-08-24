import { z } from "zod";
import { ClientOptions } from "@elastic/elasticsearch";
import fs from "fs";
import { DEFAULT_MAX_RESULT_BYTES } from "../outputBudget.js";

/**
 * The loopback hosts that may be reached over plain HTTP.
 *
 * `new URL("http://[::1]:8080").hostname` keeps the brackets, so both spellings
 * are listed rather than normalised.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * OAuth 2.1 §1.5, restated by the MCP specification: "All authorization server
 * endpoints MUST be served over HTTPS."
 *
 * The exposure here is not SSRF — this URL comes from the operator, not from an
 * untrusted party — it is the `client_secret` crossing the network in the clear.
 * Loopback is allowed because tests and local identity providers need it, and
 * there is deliberately no override flag: an `ES_OAUTH_INSECURE` would end up
 * set in production.
 */
function isSecureTokenEndpoint(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * OAuth2 client_credentials, validated as a block.
 *
 * Every field is required because the loader builds this object as soon as *any*
 * `ES_OAUTH_*` variable is set: a half-configured authentication factor must
 * fail loudly rather than fall back to the API key, because the operator would
 * then be talking to the cluster as an identity they did not choose. That is the
 * opposite of how `ES_MAX_RETRIES` is treated, and the difference is that a
 * malformed retry count has a safe default while a substituted identity has not.
 */
export const OAuthConfigSchema = z.object({
  tokenUrl: z
    .string()
    .trim()
    .min(1, "ES_OAUTH_TOKEN_URL is required to use OAuth2")
    .refine(isSecureTokenEndpoint, {
      message:
        "ES_OAUTH_TOKEN_URL must be an https:// URL (http:// is allowed only for localhost), so the client secret is not sent in the clear",
    })
    .describe("Token endpoint of the identity provider"),

  clientId: z
    .string()
    .trim()
    .min(1, "ES_OAUTH_CLIENT_ID is required to use OAuth2")
    .describe("OAuth2 client id"),

  clientSecret: z
    .string()
    .min(1, "ES_OAUTH_CLIENT_SECRET or ES_OAUTH_CLIENT_SECRET_FILE is required to use OAuth2")
    .describe("OAuth2 client secret"),

  scope: z.string().trim().optional().describe("Requested scope, if the provider needs one"),

  audience: z
    .string()
    .trim()
    .optional()
    .describe("Requested audience, which Auth0 needs to issue a JWT"),

  authStyle: z
    .enum(["post", "basic"])
    .default("post")
    .describe(
      "Client authentication: credentials in the form body (post) or in an HTTP Basic header (basic)"
    ),
});

// configuration validation schema
export const ConfigSchema = z
  .object({
    urls: z
      .union([
        z.string().trim().min(1, "Elasticsearch URL cannot be empty").url("Invalid Elasticsearch URL format"),
        z.array(z.string().trim().min(1, "Elasticsearch URL cannot be empty").url("Invalid Elasticsearch URL format"))
      ])
      .transform((val) => Array.isArray(val) ? val : [val])
      .describe("Elasticsearch server URLs (single URL or array of URLs)"),

    apiKey: z
      .string()
      .optional()
      .describe("API key for Elasticsearch authentication"),

    username: z
      .string()
      .optional()
      .describe("Username for Elasticsearch authentication"),

    password: z
      .string()
      .optional()
      .describe("Password for Elasticsearch authentication"),

    caCert: z
      .string()
      .optional()
      .describe("Path to custom CA certificate for Elasticsearch"),

    adminTools: z
      .boolean()
      .default(false)
      .describe("Expose the diagnostic tools (shards, allocation, node stats)"),

    allowDestructive: z
      .boolean()
      .default(false)
      .describe("Expose the tools that delete indices, documents or templates"),

    requestTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(30_000)
      .describe(
        "Per-request timeout in milliseconds. The 7.x client's own default is 30000, which a legitimate aggregation over a year of daily indices exceeds routinely."
      ),

    maxRetries: z
      .number()
      .int()
      .min(0)
      .default(3)
      .describe("Retries per request. 0 disables them."),

    maxResultBytes: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_MAX_RESULT_BYTES)
      .describe(
        "Ceiling on the size of one tool result. Beyond it, detail sections are omitted and the result says so."
      ),

    oauth: OAuthConfigSchema.optional().describe(
      "OAuth2 client_credentials, for a cluster reached through a gateway that validates bearer tokens"
    ),

    instanceLabel: z
      .string()
      .trim()
      .default("")
      .describe(
        "Free-text name of the deployment, e.g. production or staging. Surfaced as the server title so a client listing several instances can tell them apart."
      ),
  });

/**
 * Config as a caller supplies it: `urls` may be a single string or an array,
 * which the schema normalises. This is what `createClientOptions` accepts,
 * because it validates its own input.
 */
export type ElasticsearchConfigInput = z.input<typeof ConfigSchema>;

/** Config after validation: `urls` is always an array. */
export type ElasticsearchConfig = z.output<typeof ConfigSchema>;

// build the client options from a configuration
export function createClientOptions(
  config: ElasticsearchConfigInput
): ClientOptions {
  const validatedConfig = ConfigSchema.parse(config);
  const { urls, apiKey, username, password, caCert, oauth } = validatedConfig;

  const clientOptions: ClientOptions = {
    nodes: urls,
    // Both were the client's defaults before being exposed. They are set
    // explicitly now so the value in the config is the value in force, rather
    // than one the client happens to agree with.
    requestTimeout: validatedConfig.requestTimeoutMs,
    maxRetries: validatedConfig.maxRetries,
  };

  // Authentication. OAuth2 wins, and when it does the base client is left with
  // *no* auth at all rather than a fallback: the bearer is attached per token by
  // `createClientSource`, and if that path ever breaks the request must fail
  // with a 401 instead of quietly succeeding as whatever identity ES_API_KEY
  // names. A silent substitution of identity is the failure mode worth spending
  // a branch to prevent.
  if (!oauth) {
    if (apiKey) {
      clientOptions.auth = { apiKey };
    } else if (username && password) {
      clientOptions.auth = { username, password };
    }
  }

  // TLS, when a certificate was provided
  if (caCert) {
    try {
      const ca = fs.readFileSync(caCert);
      clientOptions.ssl = { ca };
    } catch (error) {
      console.error(
        `Failed to read certificate file: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return clientOptions;
}

/**
 * Read a numeric setting, falling back to the schema default when the variable
 * is absent or not a number.
 *
 * Returning `undefined` rather than a number is what lets zod's `.default()`
 * stay the single place the default is written. A malformed value is reported
 * and ignored: refusing to start because `ES_MAX_RETRIES=three` would take the
 * whole session down over a setting with a sane fallback.
 */
function readNumber(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;

  const value = Number(raw.trim());
  if (!Number.isFinite(value)) {
    console.error(`${name}="${raw}" is not a number; using the default.`);
    return undefined;
  }
  return value;
}

/**
 * Read the configuration from the environment.
 *
 * Returns the *input* shape, not the validated one: this function reads, it does
 * not validate. A numeric setting left unset comes back `undefined` so that
 * zod's `.default()` stays the single place each default is written, rather than
 * being repeated here where the two could drift.
 */
// build the configuration from environment variables
/**
 * Read a boolean feature flag. Only `true` and `1` enable it, so a typo leaves
 * the tools off rather than silently on. There is deliberately no un-prefixed
 * fallback: `ADMIN_TOOLS` in the ambient environment must never switch this on.
 */
function readFlag(value: string | undefined): boolean {
  const normalised = (value ?? "").trim().toLowerCase();
  return normalised === "true" || normalised === "1";
}

/**
 * Read the OAuth2 block, or nothing at all.
 *
 * The block is built as soon as *any* `ES_OAUTH_*` variable is set, so that a
 * forgotten one becomes a startup error from the schema rather than a silent
 * fallback to another authentication factor. There is deliberately no
 * un-prefixed alias for any of these: an ambient `CLIENT_SECRET` deciding which
 * identity this server presents is the `USERNAME` hazard documented in
 * CLAUDE.md, with worse consequences.
 *
 * The secret is trimmed from both sources. A secret pasted into an `mcpServers`
 * block arrives with a trailing newline often enough that Claude Code warns
 * about it, and a file written with `echo` always has one — untrimmed it
 * produces `invalid_client`, an error that says nothing about its cause.
 */
function readOAuthFromEnv(): ElasticsearchConfigInput["oauth"] {
  const secretFile = (process.env.ES_OAUTH_CLIENT_SECRET_FILE ?? "").trim();

  const present = [
    process.env.ES_OAUTH_TOKEN_URL,
    process.env.ES_OAUTH_CLIENT_ID,
    process.env.ES_OAUTH_CLIENT_SECRET,
    process.env.ES_OAUTH_CLIENT_SECRET_FILE,
    process.env.ES_OAUTH_SCOPE,
    process.env.ES_OAUTH_AUDIENCE,
    process.env.ES_OAUTH_AUTH_STYLE,
  ].some((value) => (value ?? "").trim().length > 0);

  if (!present) return undefined;

  let clientSecret = (process.env.ES_OAUTH_CLIENT_SECRET ?? "").trim();

  if (secretFile) {
    // Throwing is right here, and it is a read failure rather than a validation
    // one: `main()` turns it into `Server error: …` and exits, which is what an
    // unreadable credential deserves. Continuing would mean starting a session
    // that cannot authenticate and cannot say why.
    try {
      clientSecret = fs.readFileSync(secretFile, "utf8").trim();
    } catch (error) {
      throw new Error(
        `Cannot read ES_OAUTH_CLIENT_SECRET_FILE at ${secretFile}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  const style = (process.env.ES_OAUTH_AUTH_STYLE ?? "").trim().toLowerCase();

  return {
    tokenUrl: (process.env.ES_OAUTH_TOKEN_URL ?? "").trim(),
    clientId: (process.env.ES_OAUTH_CLIENT_ID ?? "").trim(),
    clientSecret,
    scope: (process.env.ES_OAUTH_SCOPE ?? "").trim() || undefined,
    audience: (process.env.ES_OAUTH_AUDIENCE ?? "").trim() || undefined,
    // Left undefined when unset so the schema default is the single place the
    // value is written; an unknown value reaches zod and is refused there,
    // rather than being silently read as the default.
    ...(style ? { authStyle: style as "post" | "basic" } : {}),
  };
}

export function loadConfigFromEnv(): ElasticsearchConfigInput {
  const esHost = process.env.ES_HOST || process.env.HOST || "";
  
  // several URLs may be given, comma-separated
  const urls = esHost.split(',').map(url => url.trim()).filter(url => url.length > 0);
  
  return {
    urls: urls.length > 0 ? urls : [""],
    apiKey: process.env.ES_API_KEY || process.env.API_KEY || "",
    username: process.env.ES_USERNAME || process.env.USERNAME || "",
    password: process.env.ES_PASSWORD || process.env.PASSWORD || "",
    caCert: process.env.ES_CA_CERT || process.env.CA_CERT || "",
    adminTools: readFlag(process.env.ES_ADMIN_TOOLS),
    allowDestructive: readFlag(process.env.ES_ALLOW_DESTRUCTIVE),
    instanceLabel: process.env.ES_INSTANCE_LABEL ?? "",
    requestTimeoutMs: readNumber("ES_REQUEST_TIMEOUT", process.env.ES_REQUEST_TIMEOUT),
    maxRetries: readNumber("ES_MAX_RETRIES", process.env.ES_MAX_RETRIES),
    maxResultBytes: readNumber("ES_MAX_RESULT_BYTES", process.env.ES_MAX_RESULT_BYTES),
    oauth: readOAuthFromEnv(),
  };
} 