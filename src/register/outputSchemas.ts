import { z } from "zod";

/**
 * The output schemas of the four tools whose answer is genuinely tabular.
 *
 * Four, not twenty-six. An `outputSchema` is paid for on every session, in the
 * `tools/list` payload, and earns that only where a caller would otherwise parse
 * prose: rows of indices, rows of shards, an index's settings, an index's
 * fields. `search` hits are documents of arbitrary shape, `bulk` returns a
 * report, `reindex` returns a task id — none of those is a table, and a schema
 * describing them would cost bytes to say `object`.
 *
 * They are collected here rather than inlined so the one property that matters
 * across them is visible at a glance: every listing reports `total`, `returned`
 * and `omitted`, so a caller can tell a complete answer from a trimmed one by
 * comparing two numbers instead of reading the notice meant for a human.
 *
 * Descriptions are deliberately absent. The property names carry a table, and
 * `tools/list` is measured — see `pnpm run measure`.
 */

/** A `_cat` row: every value arrives as a string, and some columns can be absent. */
const catString = z.string().optional();

export const LIST_INDICES_OUTPUT = {
  pattern: z.string(),
  total: z.number(),
  returned: z.number(),
  omitted: z.number(),
  indices: z.array(
    z.object({
      index: catString,
      health: catString,
      status: catString,
      docsCount: catString,
      storeSizeBytes: catString,
    })
  ),
};

export const LIST_SHARDS_OUTPUT = {
  index: z.string().optional(),
  total: z.number(),
  notStarted: z.number(),
  returned: z.number(),
  omitted: z.number(),
  // Loose, because the row carries `unassigned.reason` — a dotted key, which is
  // the whole reason a shard listing is worth reading when something is broken.
  shards: z.array(
    z.looseObject({
      index: catString,
      shard: catString,
      prirep: catString,
      state: catString,
      node: catString,
    })
  ),
};

export const GET_INDEX_SETTINGS_OUTPUT = {
  index: z.string(),
  found: z.boolean(),
  settings: z.record(z.string(), z.any()).optional(),
};

export const GET_MAPPINGS_OUTPUT = {
  index: z.string(),
  found: z.boolean(),
  total: z.number(),
  returned: z.number(),
  omitted: z.number(),
  // Dotted paths, so a nested field is addressable as the query DSL wants it.
  fields: z.array(z.object({ path: z.string(), type: z.string() })),
};
