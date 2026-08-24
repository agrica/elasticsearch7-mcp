/**
 * Turning "15m" into something Elasticsearch understands.
 *
 * The shorthand exists because the common case should not cost eight characters
 * of ceremony: a model asking about the last quarter of an hour writes `15m`,
 * not `now-15m`. Anything that is already a date or a date-math expression is
 * passed through untouched, so the precise case stays available.
 */

/** `15m`, `2h`, `7d` — a bare duration, meaning "ago". */
const DURATION = /^(\d+)(s|m|h|d|w)$/;

/** A date Elasticsearch will parse: ISO-8601, or epoch milliseconds. */
const ABSOLUTE = /^(\d{4}-\d{2}-\d{2}([T ].*)?|\d{10,})$/;

export type TimeBound =
  | { ok: true; value: string }
  | { ok: false; reason: string };

/**
 * Resolve one bound of a time range.
 *
 * Three forms are accepted, and everything else is refused with a message
 * listing them. Refusing is the point: a value silently treated as something
 * else would return documents from the wrong window, and a window is exactly
 * what a caller cannot check by looking at the answer.
 */
export function resolveBound(value: string, parameter: string): TimeBound {
  const trimmed = value.trim();

  if (DURATION.test(trimmed)) return { ok: true, value: `now-${trimmed}` };
  if (trimmed === "now" || trimmed.startsWith("now-") || trimmed.startsWith("now+")) {
    return { ok: true, value: trimmed };
  }
  if (ABSOLUTE.test(trimmed)) return { ok: true, value: trimmed };

  return {
    ok: false,
    reason:
      `\`${parameter}\` must be a duration ago ("15m", "2h", "7d"), a date-math ` +
      `expression ("now-1d", "now-1d/d"), or an absolute date ` +
      `("2026-08-25", "2026-08-25T10:00:00Z"). Got "${value}".`,
  };
}

/** How long a window the shorthand describes, in minutes, when it can be told. */
export function windowMinutes(since: string): number | undefined {
  const match = DURATION.exec(since.trim());
  if (!match) return undefined;

  const amount = Number(match[1]);
  const perUnit: Record<string, number> = { s: 1 / 60, m: 1, h: 60, d: 1440, w: 10_080 };
  const unit = perUnit[match[2] ?? ""];

  return unit === undefined ? undefined : amount * unit;
}

/**
 * A bucket width giving roughly thirty buckets over the window.
 *
 * Thirty is enough to see a shape and few enough to read. Only the shorthand can
 * be measured — an absolute range would need the clock, and a tool that reads
 * the clock is a tool whose tests depend on when they run — so anything else
 * falls back to an hour, and the tool says which it used.
 */
export function suggestInterval(since: string): string {
  const minutes = windowMinutes(since);
  if (minutes === undefined) return "1h";

  const ladder: readonly [number, string][] = [
    [30, "1m"],
    [180, "5m"],
    [720, "30m"],
    [2880, "1h"],
    [20_160, "6h"],
  ];

  for (const [ceiling, interval] of ladder) {
    if (minutes <= ceiling) return interval;
  }

  return "1d";
}
