import { Client, errors } from "@elastic/elasticsearch";
import type { Connection } from "@elastic/elasticsearch";
import elasticsearchMock from "@elastic/elasticsearch-mock";

/**
 * Minimal surface of @elastic/elasticsearch-mock that these tests use.
 *
 * The package declares an ESM `export default` in its .d.ts while index.js is
 * CommonJS, so TypeScript resolves the import to the module namespace and no
 * import form is constructable. The value is right at runtime — only its type
 * needs help, so the cast is done once, here.
 *
 * Note the version constraint: mock 1.x extends the 7.x client's `Connection`.
 * Mock 2.x extends `BaseConnection`, which only the 8.x client exports.
 */
export interface MockPattern {
  method: string | string[];
  path: string | string[];
  querystring?: Record<string, string>;
  body?: Record<string, any> | Record<string, any>[];
}

export interface ClientMock {
  add(pattern: MockPattern, resolver: (params: CapturedRequest) => unknown): ClientMock;
  clear(pattern: Pick<MockPattern, "method" | "path">): ClientMock;
  clearAll(): ClientMock;
  getConnection(): typeof Connection;
}

const ClientMockCtor = elasticsearchMock as unknown as new () => ClientMock;

/**
 * A `GET /` payload shaped like the target cluster's. Identifiers are
 * placeholders on purpose — this repository is public — but the three fields the
 * 7.x product check actually reads are the real ones: `version.number`,
 * `version.build_flavor` and `tagline`.
 */
export const INFO_7_8_0 = {
  name: "es-node-1",
  cluster_name: "logging-cluster",
  cluster_uuid: "AAAAAAAAAAAAAAAAAAAAAA",
  version: {
    number: "7.8.0",
    build_flavor: "default",
    build_type: "rpm",
    build_hash: "757314695644ea9a1dc2fecd26d1a43856725e65",
    build_date: "2020-06-14T19:35:50.234439Z",
    build_snapshot: false,
    lucene_version: "8.5.1",
    minimum_wire_compatibility_version: "6.8.0",
    minimum_index_compatibility_version: "6.0.0-beta1",
  },
  tagline: "You Know, for Search",
};

/** What every tool function resolves to: the MCP content shape. */
export type ToolResult = {
  content: { type: "text"; text: string }[];
};

/** Request as the mock hands it to a resolver, after deserialization. */
export type CapturedRequest = {
  method: string;
  path: string;
  body: any;
  querystring: Record<string, string>;
};

/**
 * A client wired to an in-process mock instead of a real cluster.
 *
 * `GET /` is pre-registered because the 7.x client runs its product check
 * there before the first real request: answering with a 7.8.0 payload is what
 * makes the client accept this "cluster" at all.
 */
export function createMockedClient(): { client: Client; mock: ClientMock } {
  const mock = new ClientMockCtor();
  mock.add({ method: "GET", path: "/" }, () => INFO_7_8_0);

  const client = new Client({
    node: "http://localhost:9200",
    Connection: mock.getConnection(),
  });

  return { client, mock };
}

/**
 * Register a route and capture what the tool actually sent. Asserting on the
 * captured request is the point of mocking at the connection layer: it fails
 * when the query DSL is not nested under `body`, which a hand-rolled fake
 * client would happily accept.
 */
export function capture(
  mock: ClientMock,
  pattern: { method: string | string[]; path: string },
  response: unknown
): { requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  mock.add(pattern, (params) => {
    requests.push(params);
    return response;
  });
  return { requests };
}

export function textOf(result: ToolResult): string {
  return result.content.map((fragment) => fragment.text).join("\n");
}

/** Tools never throw: they report failure as an `Error:` fragment. */
export function hasErrorFragment(result: ToolResult): boolean {
  return result.content.some((fragment) => fragment.text.startsWith("Error:"));
}

/**
 * Make every request fail with a server error.
 *
 * Failure paths must be provoked deliberately, not by leaving a route
 * unregistered: the mock answers an unknown route with 404, and a tool that
 * tolerates 404 — `getIndexTemplate` does, on purpose — would then look
 * successful. `GET /` stays registered so the failure is the API call, not the
 * product check.
 */
export function failEveryRoute(mock: ClientMock): void {
  const serverError = () =>
    new errors.ResponseError({
      body: { error: { type: "internal_server_error", reason: "boom" } },
      statusCode: 500,
      headers: {},
      warnings: null,
      meta: {},
    } as never);

  for (const method of ["GET", "POST", "PUT", "DELETE", "HEAD"]) {
    mock.add({ method, path: "/*" }, serverError);
  }
}

/**
 * The first request a route captured, with a message worth reading when the
 * tool sent none — indexing straight into the array would fail later, on a
 * property of undefined.
 */
export function firstRequest(captured: {
  requests: CapturedRequest[];
}): CapturedRequest {
  const request = captured.requests[0];
  if (!request) {
    throw new Error("expected the tool to send a request; none was captured");
  }
  return request;
}
