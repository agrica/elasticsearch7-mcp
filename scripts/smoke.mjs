#!/usr/bin/env node
/**
 * Smoke test against a real Elasticsearch 7.x cluster.
 *
 * The unit suite mocks Elasticsearch, so it cannot prove the tools work against
 * a real server; this script does. It exercises the very same tool functions the
 * MCP server exposes, imported from the built output.
 *
 * Usage:
 *   npm run build
 *   ES_HOST=http://your-cluster:9200 node scripts/smoke.mjs
 *   ES_HOST=... node scripts/smoke.mjs --write smoke-test
 *
 * Read-only by default — including the diagnostic tools, which only read and are
 * therefore safe against production. `--write <prefix>` additionally exercises
 * create_index, create_mapping, bulk, reindex, the index-template tools and the
 * destructive tools against throwaway indices named <prefix>-* , then deletes
 * what it created.
 *
 * The environment flags (ES_ADMIN_TOOLS, ES_ALLOW_DESTRUCTIVE) gate MCP
 * *registration*, not the functions themselves, so this script calls them
 * directly regardless: what it verifies is that the API calls work on a 7.x
 * server, which is independent of what a given deployment chooses to expose.
 *
 * Tool functions never throw: they return their failure as a text fragment
 * prefixed `Error:`. Detection therefore scans the returned fragments,
 * and the process exits non-zero if any check failed.
 */

import { Client } from "@elastic/elasticsearch";
import {
  loadConfigFromEnv,
  createClientOptions,
} from "../dist/src/config/schema.js";
import {
  getClusterHealth,
  listIndices,
  getMappings,
  search,
  createIndex,
  createMapping,
  bulk,
  reindex,
  createIndexTemplate,
  getIndexTemplate,
  deleteIndexTemplate,
  count,
  getDocument,
  getAliases,
  listTasks,
  getClusterInfo,
  getClusterSettings,
  getIndexSettings,
  getIndexStats,
  listShards,
  listNodes,
  explainAllocation,
  deleteIndex,
  deleteDocument,
  deleteByQuery,
} from "../dist/src/server.js";

const writeFlagIndex = process.argv.indexOf("--write");
const writePrefix =
  writeFlagIndex === -1 ? null : process.argv[writeFlagIndex + 1];

if (writeFlagIndex !== -1 && !writePrefix) {
  console.error("--write requires an index prefix, e.g. --write smoke-test");
  process.exit(2);
}

let failures = 0;
let skipped = 0;

function render(result) {
  return (result?.content ?? [])
    .map((fragment) => fragment.text)
    .join("\n")
    .trim();
}

function failed(result) {
  return (result?.content ?? []).some(
    (fragment) =>
      typeof fragment.text === "string" && fragment.text.startsWith("Error:")
  );
}

function truncate(text, max = 400) {
  return text.length > max ? `${text.slice(0, max)}\n  […tronqué]` : text;
}

async function check(label, run) {
  process.stdout.write(`\n── ${label}\n`);
  let result;
  try {
    result = await run();
  } catch (error) {
    // A throw here is itself a finding: the tool contract forbids it.
    failures++;
    console.error(
      `  FAIL (exception, ce qui viole le contrat des outils): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
  const text = render(result);
  if (failed(result)) {
    failures++;
    console.error(`  FAIL\n${truncate(text)
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n")}`);
  } else {
    console.log(
      truncate(text)
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n") || "  (réponse vide)"
    );
    console.log("  OK");
  }
  return result;
}

function skip(label, reason) {
  skipped++;
  console.log(`\n── ${label}\n  SKIP — ${reason}`);
}

/** Pick a non-system index out of the list_indices JSON fragment. */
function firstUserIndex(result) {
  for (const fragment of result?.content ?? []) {
    let parsed;
    try {
      parsed = JSON.parse(fragment.text);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    const found = parsed.find(
      (entry) => typeof entry.index === "string" && !entry.index.startsWith(".")
    );
    if (found) return found.index;
  }
  return null;
}

const config = loadConfigFromEnv();
const esClient = new Client(createClientOptions(config));

console.log(`Cible : ${JSON.stringify(config.urls)}`);

// Proves the 7.17 client's product check accepted this cluster — without it,
// every call below would fail identically and the cause would be invisible.
try {
  const info = await esClient.info();
  console.log(
    `Cluster : ${info.body.cluster_name} — Elasticsearch ${info.body.version.number} (${info.body.version.build_flavor})`
  );
} catch (error) {
  console.error(
    `Impossible de joindre le cluster : ${
      error instanceof Error ? error.message : String(error)
    }`
  );
  process.exit(1);
}

await check("cluster_info", () => getClusterInfo(esClient));
await check("elasticsearch_health", () => getClusterHealth(esClient, true));

const indices = await check("list_indices", () => listIndices(esClient));
const sampleIndex = firstUserIndex(indices);

if (sampleIndex) {
  await check(`get_mappings (${sampleIndex})`, () =>
    getMappings(esClient, sampleIndex)
  );
  await check(`search (${sampleIndex}, size 1)`, () =>
    search(esClient, sampleIndex, { size: 1, query: { match_all: {} } })
  );
  await check(`count (${sampleIndex})`, () => count(esClient, sampleIndex));
  await check(`get_index_settings (${sampleIndex})`, () =>
    getIndexSettings(esClient, sampleIndex)
  );
  await check(`get_index_stats (${sampleIndex})`, () =>
    getIndexStats(esClient, sampleIndex)
  );
} else {
  for (const tool of [
    "get_mappings",
    "search",
    "count",
    "get_index_settings",
    "get_index_stats",
  ]) {
    skip(tool, "aucun index non-système trouvé sur le cluster");
  }
}

// Diagnostics: read-only, so they run against any cluster including production.
await check("get_aliases", () => getAliases(esClient));
await check("get_cluster_settings", () => getClusterSettings(esClient));
await check("list_shards", () => listShards(esClient));
await check("list_nodes", () => listNodes(esClient));
await check("list_tasks", () => listTasks(esClient));

// allocation/explain answers 400 on a healthy cluster ("unable to find any
// unassigned shards"), which is the expected reply and not a failure — so it is
// only meaningful where something is actually broken.
if (process.argv.includes("--explain-allocation")) {
  await check("explain_allocation", () => explainAllocation(esClient));
} else {
  skip(
    "explain_allocation",
    "400 sur un cluster sain ; --explain-allocation pour le forcer"
  );
}

if (!writePrefix) {
  console.log(
    "\nLes outils d'écriture (create_index, create_mapping, bulk, reindex, templates) ne sont pas testés."
  );
  console.log("Pour les exercer sur des index jetables : --write <prefix>");
} else {
  const target = `${writePrefix}-src`;
  const copy = `${writePrefix}-copy`;
  const templateName = `${writePrefix}-template`;

  try {
    await check(`create_index (${target})`, () =>
      createIndex(
        esClient,
        target,
        { number_of_shards: 1, number_of_replicas: 0 },
        { properties: { message: { type: "text" } } }
      )
    );

    await check(`create_mapping (${target})`, () =>
      createMapping(esClient, target, {
        properties: { level: { type: "keyword" } },
      })
    );

    await check(`bulk (${target})`, () =>
      bulk(
        esClient,
        target,
        [
          { id: "1", message: "premier document de fumée", level: "info" },
          { id: "2", message: "second document de fumée", level: "warn" },
        ],
        "id"
      )
    );

    // bulk uses refresh: true, so the documents must already be searchable.
    await check(`search (${target}, après bulk)`, () =>
      search(esClient, target, { size: 5, query: { match: { message: "fumée" } } })
    );

    await check(`reindex (${target} -> ${copy})`, () =>
      reindex(esClient, target, copy)
    );

    await check(`create_index_template (${templateName})`, () =>
      createIndexTemplate(
        esClient,
        templateName,
        [`${writePrefix}-pattern-*`],
        { settings: { number_of_shards: 1 } },
        100,
        1
      )
    );

    await check(`get_index_template (${templateName})`, () =>
      getIndexTemplate(esClient, templateName)
    );

    await check(`delete_index_template (${templateName})`, () =>
      deleteIndexTemplate(esClient, templateName)
    );

    await check(`get_document (${target}/1)`, () =>
      getDocument(esClient, target, "1")
    );

    await check(`delete_document (${target}/1)`, () =>
      deleteDocument(esClient, target, "1")
    );

    await check(`delete_by_query (${target}, level=warn)`, () =>
      deleteByQuery(esClient, target, { term: { level: "warn" } })
    );

    // The guardrail must hold even here, where the flag would be on.
    await check(`delete_index refuse "${writePrefix}-*"`, async () => {
      const result = await deleteIndex(esClient, `${writePrefix}-*`);
      const text = render(result);
      if (!text.includes("Refusing")) {
        return {
          content: [
            {
              type: "text",
              text: `Error: le garde-fou n'a pas refusé le motif, réponse : ${text}`,
            },
          ],
        };
      }
      return result;
    });

    await check(`delete_index (${copy})`, () => deleteIndex(esClient, copy));
  } finally {
    // Cleanup uses the raw client: an index delete_index already removed is a
    // no-op here thanks to ignore: [404].
    for (const index of [target, copy]) {
      try {
        await esClient.indices.delete({ index }, { ignore: [404] });
        console.log(`\nNettoyage : index "${index}" supprimé.`);
      } catch (error) {
        console.error(
          `\nNettoyage à faire à la main pour "${index}" : ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }
}

console.log(
  `\n${failures === 0 ? "Tous les contrôles exécutés sont passés" : `${failures} contrôle(s) en échec`}${
    skipped > 0 ? ` — ${skipped} ignoré(s)` : ""
  }.`
);
process.exit(failures === 0 ? 0 : 1);
