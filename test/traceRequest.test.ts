import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRACE_HITS,
  MAX_TRACE_HITS,
  traceRequest,
} from "../src/tools/ecs/traceRequest.js";
import {
  capture,
  createMockedClient,
  failEveryRoute,
  firstRequest,
  hasErrorFragment,
  isFailure,
  textOf,
} from "./support/mockClient.js";

const PATTERN = "logs-app-*";
const ROUTE = { method: "POST", path: "/logs-app-*/_search" };
const ID = "aowQJmtrwvjJOWI3TyL_SAAAAA4";

function hit(source: Record<string, unknown>) {
  return { _index: "logs-app-2026.08.25", _id: "1", _score: null, _source: source };
}

/** A hop bucket in the shape the `hops` aggregation returns it. */
function hop(
  service: string,
  count: number,
  first: string,
  last: string,
  env = "prod",
  host = "srv-1"
) {
  return {
    key: service,
    doc_count: count,
    first: { value: Date.parse(first), value_as_string: first },
    last: { value: Date.parse(last), value_as_string: last },
    env: { buckets: [{ key: env, doc_count: count }] },
    host: { buckets: [{ key: host, doc_count: count }] },
  };
}

const FAILING = /^(err|error|fatal|crit|critical|severe|emergency|alert|panic)$/i;

/**
 * The mocked response.
 *
 * The `failures` aggregation defaults to the failing hits among those given, so
 * a test that only cares about rendering does not have to spell it out. The
 * `failures` option overrides it, which is how the capped-timeline case is
 * expressed: the aggregation reports more than the timeline holds.
 */
function response(
  hits: ReturnType<typeof hit>[],
  options: {
    total?: number;
    hops?: ReturnType<typeof hop>[];
    levels?: { key: string; doc_count: number }[];
    failures?: { count: number; events?: ReturnType<typeof hit>[] };
  } = {}
) {
  const derived = hits.filter((entry) =>
    FAILING.test(String(entry._source["log.level"] ?? ""))
  );
  const failures = options.failures ?? { count: derived.length, events: derived };

  return {
    took: 4,
    hits: { total: { value: options.total ?? hits.length, relation: "eq" }, hits },
    aggregations: {
      hops: { buckets: options.hops ?? [] },
      levels: { buckets: options.levels ?? [] },
      failures: {
        doc_count: failures.count,
        events: { hits: { total: { value: failures.count }, hits: failures.events ?? [] } },
      },
    },
  };
}

describe("traceRequest", () => {
  it("matches either correlation field, and requires one of them to match", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, response([]));

    await traceRequest(client, PATTERN, ID);

    // `should` without `minimum_should_match` would only influence scoring, and
    // the tool would answer with the whole window instead of one request. That
    // is the failure this asserts against, not the presence of the clause.
    const bool = firstRequest(captured).body.query.bool;
    expect(bool.should).toContainEqual({ term: { "trace.id": ID } });
    expect(bool.should).toContainEqual({ term: { "http.request.id": ID } });
    expect(bool.minimum_should_match).toBe(1);
  });

  it("keeps the shared filters alongside the identifier", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, response([]));

    await traceRequest(client, PATTERN, ID, { env: "staging", service: "billing" });

    const body = firstRequest(captured).body;
    expect(body.query.bool.filter).toContainEqual({ terms: { "service.environment": ["staging"] } });
    expect(body.query.bool.filter).toContainEqual({ terms: { "service.name": ["billing"] } });
    expect(body.query.bool.minimum_should_match).toBe(1);
  });

  it("looks back a day by default, not the fifteen minutes the other tools use", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, response([]));

    await traceRequest(client, PATTERN, ID);

    // A caller arrives here with an identifier read off an error that may be
    // hours old; 15m would answer "no such request" for the normal case.
    expect(firstRequest(captured).body.query.bool.filter).toContainEqual({
      range: { "@timestamp": { gte: "now-24h" } },
    });
  });

  it("reads oldest first, because a chain is followed forwards", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, response([]));

    await traceRequest(client, PATTERN, ID);

    expect(firstRequest(captured).body.sort).toEqual([{ "@timestamp": { order: "asc" } }]);
  });

  it("asks for the environment, and for the stack trace only when it will be printed", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, response([]));

    await traceRequest(client, PATTERN, ID);
    const quiet = firstRequest(captured).body._source;
    expect(quiet).toContain("service.environment");
    expect(quiet).not.toContain("error.stack_trace");

    const verbose = createMockedClient();
    const verboseCapture = capture(verbose.mock, ROUTE, response([]));
    await traceRequest(verbose.client, PATTERN, ID, { verbose: true });
    expect(firstRequest(verboseCapture).body._source).toContain("error.stack_trace");
  });

  it("refuses an empty identifier instead of returning the whole window", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, response([]));

    const result = await traceRequest(client, PATTERN, "   ");

    expect(isFailure(result)).toBe(true);
    expect(textOf(result)).toContain("correlation identifier is required");
    expect(captured.requests).toHaveLength(0);
  });

  it("reports the chain in the order each service first appears", async () => {
    const { client, mock } = createMockedClient();
    capture(
      mock,
      ROUTE,
      response(
        [
          hit({
            "@timestamp": "2026-08-25T09:00:00.000Z",
            "service.name": "web",
            "log.level": "INFO",
            message: "in",
          }),
          hit({
            "@timestamp": "2026-08-25T09:00:02.500Z",
            "service.name": "referential",
            "log.level": "INFO",
            message: "out",
          }),
        ],
        {
          hops: [
            hop("web", 12, "2026-08-25T09:00:00.000Z", "2026-08-25T09:00:03.000Z", "prod", "web-1"),
            hop("bff", 40, "2026-08-25T09:00:00.500Z", "2026-08-25T09:00:02.900Z", "prod", "bff-1"),
            hop("referential", 3, "2026-08-25T09:00:02.000Z", "2026-08-25T09:00:02.500Z", "qualif", "refp-1"),
          ],
          levels: [{ key: "INFO", doc_count: 53 }, { key: "ERROR", doc_count: 2 }],
        }
      )
    );

    const text = textOf(await traceRequest(client, PATTERN, ID));

    expect(text).toContain("across 3 services");
    expect(text.indexOf("1. web/prod")).toBeGreaterThan(-1);
    expect(text.indexOf("1. web/prod")).toBeLessThan(text.indexOf("2. bff/prod"));
    expect(text.indexOf("2. bff/prod")).toBeLessThan(text.indexOf("3. referential/qualif"));
    // The environment travels with the service name: on a shared cluster the
    // name alone does not say which deployment answered.
    expect(text).toContain("referential/qualif");
    expect(text).toContain("2500 ms");
    expect(text).toContain("ERROR 2");
  });

  it("lifts the failing events out of the timeline", async () => {
    const { client, mock } = createMockedClient();
    capture(
      mock,
      ROUTE,
      response(
        [
          hit({
            "@timestamp": "2026-08-25T09:00:00.000Z",
            "service.name": "web",
            "log.level": "INFO",
            message: "fine",
          }),
          hit({
            "@timestamp": "2026-08-25T09:00:01.000Z",
            "service.name": "bff",
            "log.level": "ERROR",
            "log.logger": "DocumentService",
            "error.type": "NotFound",
            message: "commercial documents unavailable",
          }),
        ],
        { hops: [hop("web", 1, "2026-08-25T09:00:00.000Z", "2026-08-25T09:00:00.000Z")] }
      )
    );

    const text = textOf(await traceRequest(client, PATTERN, ID));

    expect(text).toContain("1 failing event");
    expect(text).toContain("commercial documents unavailable");
    expect(text).toContain("[NotFound]");
  });

  it("counts SEVERE and FATAL as failures too, since ECS fixes no vocabulary", async () => {
    const { client, mock } = createMockedClient();
    capture(
      mock,
      ROUTE,
      response([
        hit({ "@timestamp": "2026-08-25T09:00:00.000Z", "log.level": "SEVERE", message: "jul" }),
        hit({ "@timestamp": "2026-08-25T09:00:01.000Z", "log.level": "fatal", message: "down" }),
      ])
    );

    expect(textOf(await traceRequest(client, PATTERN, ID))).toContain("2 failing events");
  });

  it("reports failures the timeline does not reach", async () => {
    // The defect this guards against, found against a real 385-event trace: the
    // one ERROR sat past the 200th line, so failures derived from the returned
    // hits were empty and the tool answered with a chain and no reason it broke.
    const { client, mock } = createMockedClient();
    capture(
      mock,
      ROUTE,
      response(
        [hit({ "@timestamp": "2026-08-25T09:00:00.000Z", "log.level": "INFO", message: "first line" })],
        {
          total: 385,
          failures: {
            count: 3,
            events: [
              hit({
                "@timestamp": "2026-08-25T09:05:00.000Z",
                "service.name": "referential",
                "log.level": "ERROR",
                message: "past the timeline",
              }),
            ],
          },
        }
      )
    );

    const text = textOf(await traceRequest(client, PATTERN, ID, { limit: 1 }));

    expect(text).toContain("3 failing events, first 1:");
    expect(text).toContain("past the timeline");
  });

  it("says the identifier matched nothing, and where to look instead", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, ROUTE, response([]));

    const text = textOf(await traceRequest(client, PATTERN, ID));

    // Not a failure — an empty trace is a valid answer. But a bare "0 events"
    // reads as "the request was fine", so it has to say which fields it checked.
    expect(text).toContain("trace.id");
    expect(text).toContain("http.request.id");
    expect(text).toContain("top_values");
  });

  it("caps the timeline and says the chain is still complete", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, response([], { total: 4000 }));

    await traceRequest(client, PATTERN, ID, { limit: 5000 });
    expect(firstRequest(captured).body.size).toBe(MAX_TRACE_HITS);

    const second = createMockedClient();
    const defaulted = capture(second.mock, ROUTE, response([], { total: 4000 }));
    await traceRequest(second.client, PATTERN, ID, {});
    expect(firstRequest(defaulted).body.size).toBe(DEFAULT_TRACE_HITS);
  });

  it("returns a failure fragment rather than throwing when the cluster refuses", async () => {
    const { client, mock } = createMockedClient();
    failEveryRoute(mock);

    const result = await traceRequest(client, PATTERN, ID);

    // Le contexte part sur stderr, pas dans le fragment : un message d'erreur du
    // client ES peut embarquer les identifiants du noeud. On verifie le contrat.
    expect(hasErrorFragment(result)).toBe(true);
    expect(result.isError).toBe(true);
  });
});
