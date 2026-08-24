#!/usr/bin/env node
/**
 * Assert that an MCP server answered `tools/list` with the expected tool set.
 *
 * Reads a JSON-RPC response stream (one message per line) from the file given
 * as the first argument. Used by CI to check that the Docker image really
 * serves the protocol, not merely that it builds — but it works against any
 * transport that produced a response file.
 *
 * Usage:
 *   node scripts/check-mcp-tools.mjs mcp-response.jsonl
 */

import { readFileSync } from "node:fs";

/**
 * The default tool set — what the image serves with no flag set.
 *
 * The check is exact in both directions: a tool missing here fails, and so does
 * one that appears unexpectedly. That second half is the valuable one, because
 * it is what catches a diagnostic or destructive tool leaking into a default
 * deployment. `delete_index_template` is deliberately absent: it moved behind
 * ES_ALLOW_DESTRUCTIVE.
 */
const EXPECTED_TOOLS = [
  "bulk",
  "cluster_info",
  "count",
  "create_index",
  "create_index_template",
  "create_mapping",
  "elasticsearch_health",
  "get_aliases",
  "get_document",
  "get_index_template",
  "get_mappings",
  "get_task",
  "list_indices",
  "reindex",
  "search",
];

const path = process.argv[2];

if (!path) {
  console.error("usage: node scripts/check-mcp-tools.mjs <response.jsonl>");
  process.exit(2);
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

let messages;
try {
  messages = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        fail(`line ${index + 1} of ${path} is not JSON: ${line.slice(0, 120)}`);
      }
    });
} catch (error) {
  fail(`cannot read ${path}: ${error.message}`);
}

// The handshake sends initialize as id 1 and tools/list as id 2.
const initialized = messages.find((message) => message.id === 1);
if (!initialized) fail("the server never answered initialize");
if (initialized.error) fail(`initialize failed: ${JSON.stringify(initialized.error)}`);

const serverInfo = initialized.result?.serverInfo;
if (serverInfo) {
  console.log(`server: ${serverInfo.name} ${serverInfo.version}`);
}

const listed = messages.find((message) => message.id === 2);
if (!listed) fail("the server never answered tools/list");
if (listed.error) fail(`tools/list failed: ${JSON.stringify(listed.error)}`);

const names = (listed.result?.tools ?? []).map((tool) => tool.name).sort();

const missing = EXPECTED_TOOLS.filter((name) => !names.includes(name));
const unexpected = names.filter((name) => !EXPECTED_TOOLS.includes(name));

if (missing.length > 0) fail(`missing tools: ${missing.join(", ")}`);
if (unexpected.length > 0) fail(`unexpected tools: ${unexpected.join(", ")}`);

// A tool with no description is unusable: it is what the calling model reads.
const undescribed = (listed.result?.tools ?? [])
  .filter((tool) => !tool.description || !tool.inputSchema)
  .map((tool) => tool.name);
if (undescribed.length > 0) {
  fail(`tools without a description or input schema: ${undescribed.join(", ")}`);
}

console.log(`OK: ${names.length} tools exposed — ${names.join(", ")}`);
