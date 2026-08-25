/**
 * The ECS field names this module speaks, and the level vocabulary it tolerates.
 *
 * Every name lives here once, because a typo in one of them does not fail: it
 * returns zero documents, which a calling model reads as "there is nothing".
 * A silent empty answer is the failure mode worth centralising against.
 *
 * The types are those of **ECS 1.x**, which is what an Elasticsearch 7.8 cluster
 * can express: `match_only_text` arrived in 7.14 and `wildcard` in 7.9, so a
 * mapping pushed to 7.8 necessarily predates ECS 1.12, where `error.message`
 * and `error.stack_trace` moved to those types. See
 * docs/superpowers/specs/2026-08-25-ecs-log-search-design.md.
 */

/** The event time. Every filter and every histogram is built on it. */
export const TIMESTAMP = "@timestamp";

/** Aggregatable and filterable: `keyword` in every ECS 1.x revision. */
export const KEYWORD_FIELDS = {
  level: "log.level",
  logger: "log.logger",
  service: "service.name",
  environment: "service.environment",
  host: "host.name",
  errorType: "error.type",
  dataset: "event.dataset",
  traceId: "trace.id",
  requestId: "http.request.id",
} as const;

/**
 * The two fields that can carry a correlation identifier, and why both are needed.
 *
 * `trace.id` is the ECS field for distributed tracing, and it is the right one on
 * a cluster instrumented with APM or OpenTelemetry. But a plain Spring or Apache
 * stack emits no `trace.id` at all: what propagates between its services is the
 * request identifier, which ECS types as `http.request.id`. Measured on the
 * cluster this module was written against, over one day: `http.request.id` on
 * 3 210 868 documents, `trace.id` on 9 205, `span.id` on none — so a tool that
 * looked only at `trace.id` would answer "no such trace" for 99.7% of requests.
 *
 * `trace_request` therefore matches either, rather than making the caller know
 * which convention their cluster follows. The order is the ECS-canonical one
 * first, because a cluster that populates both means `trace.id` deliberately.
 */
export const CORRELATION_FIELDS: readonly string[] = [
  KEYWORD_FIELDS.traceId,
  KEYWORD_FIELDS.requestId,
];

/**
 * Free text: `text` in ECS 1.x, so searchable and *not* aggregatable.
 *
 * This is why `error_summary` groups on `error.type`. `error.message` has no
 * `keyword` sub-field in ECS, so grouping errors by their message is out of
 * reach unless a local dynamic template adds one.
 */
export const TEXT_FIELDS = {
  message: "message",
  errorMessage: "error.message",
} as const;

/**
 * The stack trace, requested only when asked for.
 *
 * `keyword` in ECS 1.x, hence aggregatable — and that is a trap rather than an
 * opportunity: ECS puts `ignore_above: 1024` on keyword fields, so a longer
 * trace is not indexed and disappears from any aggregation over it. The count
 * would be wrong in a way that looks right. Read it, never group on it.
 */
export const STACK_TRACE = "error.stack_trace";

/** What a log line is rendered from, and therefore what `_source` asks for. */
export const RENDERED_FIELDS: readonly string[] = [
  TIMESTAMP,
  TEXT_FIELDS.message,
  TEXT_FIELDS.errorMessage,
  KEYWORD_FIELDS.level,
  KEYWORD_FIELDS.logger,
  KEYWORD_FIELDS.service,
  KEYWORD_FIELDS.host,
  KEYWORD_FIELDS.errorType,
  KEYWORD_FIELDS.traceId,
];

/**
 * The severity ladder, lowest first, with the aliases each rank is written as.
 *
 * ECS types `log.level` as a keyword and imposes no vocabulary, so what is
 * actually indexed depends on the logging library: `WARN` from Logback, `WARNING`
 * from Python, `SEVERE` from java.util.logging. A ladder that recognised only
 * one spelling would drop the others from a `minLevel` filter without a word,
 * which is the wrong-answer failure this module exists to avoid.
 */
export const LEVEL_LADDER: readonly (readonly string[])[] = [
  ["trace"],
  ["debug", "fine", "finer", "finest"],
  ["info", "information", "notice", "config"],
  ["warn", "warning"],
  ["error", "err", "severe"],
  ["fatal", "critical", "crit", "emergency", "alert", "panic"],
];

/** The rank a written level belongs to, or -1 when the ladder does not know it. */
function rankOf(level: string): number {
  const needle = level.trim().toLowerCase();
  return LEVEL_LADDER.findIndex((aliases) => aliases.includes(needle));
}

/**
 * Case variants of one alias.
 *
 * `log.level` is a keyword, so the match is exact and case-sensitive, while the
 * spelling is the library's choice: `ERROR` from Logback, `error` from pino's ECS
 * formatter, `Error` from a handful of .NET sinks. Asking for all three costs a
 * few terms in a clause that can hold thousands.
 */
function caseVariants(alias: string): string[] {
  const lower = alias.toLowerCase();
  const capitalised = lower.charAt(0).toUpperCase() + lower.slice(1);
  return [lower, lower.toUpperCase(), capitalised];
}

/**
 * The exact terms to filter `log.level` on.
 *
 * A name the ladder knows is expanded to its rank's aliases — asking for `ERROR`
 * finds `SEVERE` too, because they are the same severity written differently. A
 * name it does not know is passed through **exactly as given**, and this is the
 * important half: a cluster with a custom level must remain queryable, and the
 * caller who typed it knows something the ladder does not.
 */
export function levelTerms(levels: readonly string[]): string[] {
  const terms = new Set<string>();

  for (const level of levels) {
    const rank = rankOf(level);
    if (rank === -1) {
      terms.add(level);
      continue;
    }
    for (const alias of LEVEL_LADDER[rank] ?? []) {
      for (const variant of caseVariants(alias)) terms.add(variant);
    }
  }

  return [...terms];
}

/**
 * Every term at or above a severity, or `undefined` if the ladder cannot place
 * it — in which case the caller is told, rather than handed a filter that
 * quietly means something else.
 */
export function minLevelTerms(level: string): string[] | undefined {
  const rank = rankOf(level);
  if (rank === -1) return undefined;

  const terms = new Set<string>();
  for (const aliases of LEVEL_LADDER.slice(rank)) {
    for (const alias of aliases) {
      for (const variant of caseVariants(alias)) terms.add(variant);
    }
  }

  return [...terms];
}

/** The canonical names a rejected `minLevel` should be told about. */
export function knownLevels(): string[] {
  return LEVEL_LADDER.map((aliases) => (aliases[0] ?? "").toUpperCase());
}
