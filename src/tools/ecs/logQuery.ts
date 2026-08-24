import type { estypes } from "@elastic/elasticsearch";
import {
  KEYWORD_FIELDS,
  TEXT_FIELDS,
  TIMESTAMP,
  knownLevels,
  levelTerms,
  minLevelTerms,
} from "./fields.js";
import { resolveBound } from "./timeRange.js";

/**
 * The filters every tool in this module shares.
 *
 * Named parameters rather than a query DSL, deliberately: `search` already
 * accepts arbitrary DSL, and a second door onto it here would be a duplicate
 * with two ways to get it wrong — while costing the schema bytes that make this
 * module worth having.
 */
export type LogFilters = {
  service?: string | string[];
  levels?: string[];
  minLevel?: string;
  since?: string;
  until?: string;
  query?: string;
  host?: string | string[];
  logger?: string | string[];
  dataset?: string | string[];
  traceId?: string;
};

export type BuiltQuery =
  | { ok: true; query: estypes.QueryDslQueryContainer; described: string }
  | { ok: false; reason: string };

/** The default window: recent enough to be about now, wide enough to hold something. */
export const DEFAULT_SINCE = "15m";

function asArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).filter((entry) => entry.length > 0);
}

/**
 * Build the `bool.filter` every log question starts from.
 *
 * Everything lands in `filter` rather than `must`, because none of it is a
 * relevance question — a service name either matches or it does not, and scoring
 * it would only cost the cluster work. The free-text `query` is the exception,
 * and it goes in `must` where its score orders nothing (results are sorted by
 * time) but its analysis still applies.
 *
 * Returns the description alongside, so the answer can state the window and the
 * filters it actually used. A caller who typed `15m` needs to see `now-15m` to
 * know the shorthand was understood the way they meant.
 */
export function buildLogQuery(filters: LogFilters): BuiltQuery {
  const conditions: estypes.QueryDslQueryContainer[] = [];
  const described: string[] = [];

  const since = filters.since ?? DEFAULT_SINCE;
  const from = resolveBound(since, "since");
  if (!from.ok) return { ok: false, reason: from.reason };

  const range: estypes.QueryDslRangeQuery = { gte: from.value };
  let windowDescription = `${from.value} → now`;

  if (filters.until !== undefined && filters.until.trim().length > 0) {
    const to = resolveBound(filters.until, "until");
    if (!to.ok) return { ok: false, reason: to.reason };
    range.lte = to.value;
    windowDescription = `${from.value} → ${to.value}`;
  }

  conditions.push({ range: { [TIMESTAMP]: range } });
  described.push(windowDescription);

  // Levels. `minLevel` and `levels` are not exclusive — asking for WARN and above
  // plus a custom level is a legitimate question — so their terms are unioned.
  const levels = new Set<string>();
  if (filters.minLevel !== undefined && filters.minLevel.trim().length > 0) {
    const terms = minLevelTerms(filters.minLevel);
    if (terms === undefined) {
      return {
        ok: false,
        reason:
          `\`minLevel\` "${filters.minLevel}" is not a severity this server can order. ` +
          `Known: ${knownLevels().join(", ")}. Pass the exact value in \`levels\` instead ` +
          `— use top_values on log.level to see what this cluster actually indexes.`,
      };
    }
    for (const term of terms) levels.add(term);
    described.push(`level >= ${filters.minLevel.toUpperCase()}`);
  }

  if (filters.levels !== undefined && filters.levels.length > 0) {
    for (const term of levelTerms(filters.levels)) levels.add(term);
    described.push(`level in [${filters.levels.join(", ")}]`);
  }

  if (levels.size > 0) {
    conditions.push({ terms: { [KEYWORD_FIELDS.level]: [...levels] } });
  }

  const keywordFilters: [string, string | string[] | undefined, string][] = [
    [KEYWORD_FIELDS.service, filters.service, "service"],
    [KEYWORD_FIELDS.host, filters.host, "host"],
    [KEYWORD_FIELDS.logger, filters.logger, "logger"],
    [KEYWORD_FIELDS.dataset, filters.dataset, "dataset"],
    [KEYWORD_FIELDS.traceId, filters.traceId, "trace"],
  ];

  for (const [field, value, label] of keywordFilters) {
    const values = asArray(value);
    if (values.length === 0) continue;
    conditions.push({ terms: { [field]: values } });
    described.push(`${label}=${values.join("|")}`);
  }

  const bool: estypes.QueryDslBoolQuery = { filter: conditions };

  if (filters.query !== undefined && filters.query.trim().length > 0) {
    // Both text fields at once: a stack-trace-only match is still the event the
    // caller was looking for, and ECS splits the human part of an event across
    // `message` and `error.message` depending on which layer logged it.
    bool.must = [
      {
        multi_match: {
          query: filters.query,
          fields: [TEXT_FIELDS.message, TEXT_FIELDS.errorMessage],
        },
      },
    ];
    described.push(`text "${filters.query}"`);
  }

  return { ok: true, query: { bool }, described: described.join("  ") };
}
