import { z } from "zod";
import { ClientOptions } from "@elastic/elasticsearch";
import fs from "fs";
import { DEFAULT_MAX_RESULT_BYTES } from "../outputBudget.js";

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
  const { urls, apiKey, username, password, caCert } = validatedConfig;

  const clientOptions: ClientOptions = {
    nodes: urls,
    // Both were the client's defaults before being exposed. They are set
    // explicitly now so the value in the config is the value in force, rather
    // than one the client happens to agree with.
    requestTimeout: validatedConfig.requestTimeoutMs,
    maxRetries: validatedConfig.maxRetries,
  };

  // authentication
  if (apiKey) {
    clientOptions.auth = { apiKey };
  } else if (username && password) {
    clientOptions.auth = { username, password };
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
  };
} 