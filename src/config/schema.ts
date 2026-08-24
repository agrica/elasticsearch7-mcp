import { z } from "zod";
import { ClientOptions } from "@elastic/elasticsearch";
import fs from "fs";

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

export function loadConfigFromEnv(): ElasticsearchConfig {
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
  };
} 