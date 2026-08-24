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
  isError?: boolean;
};

/** Request as the mock hands it to a resolver, after deserialization. */
export type CapturedRequest = {
  method: string;
  path: string;
  body: any;
  querystring: Record<string, string>;
  /**
   * The headers that actually went on the wire. The mock's resolver receives the
   * connection's own request params, so this is the real merged set — which is
   * what lets a test assert *which* credential a request carried.
   */
  headers?: Record<string, any>;
};

/**
 * A client wired to an in-process mock instead of a real cluster.
 *
 * `GET /` is pre-registered because the 7.x client runs its product check
 * there before the first real request: answering with a 7.8.0 payload is what
 * makes the client accept this "cluster" at all.
 */
export function createMockedClient(
  options: Partial<ConstructorParameters<typeof Client>[0]> = {}
): { client: Client; mock: ClientMock; sentHeaders: Record<string, string>[] } {
  const mock = new ClientMockCtor();
  mock.add({ method: "GET", path: "/" }, () => INFO_7_8_0);

  // Headers are recorded at the connection, not in the route resolver: the mock
  // package strips them before calling the resolver, which receives only
  // method, path, body and querystring. The connection's `request` is where the
  // merged set exists — the same place the real client would send from — so this
  // is what makes "which credential did this request carry" an answerable
  // question. Subclassing the mock's own Connection is its supported extension
  // point; the `any` is the same concession the cast above documents.
  const sentHeaders: Record<string, string>[] = [];
  const MockConnection = mock.getConnection();

  class RecordingConnection extends MockConnection {
    request(params: any, callback: any): any {
      sentHeaders.push({ ...(params?.headers ?? {}) });
      return (super.request as any)(params, callback);
    }
  }

  const client = new Client({
    node: "http://localhost:9200",
    Connection: RecordingConnection as unknown as typeof Connection,
    ...options,
  });

  return { client, mock, sentHeaders };
}

/** The Authorization header of the last request that reached the connection. */
export function lastAuthorization(
  sentHeaders: Record<string, string>[]
): string | undefined {
  return sentHeaders[sentHeaders.length - 1]?.authorization;
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
 * A failed call as the protocol defines one: `isError` set, and readable text
 * saying why.
 *
 * The flag is the part that matters. The `Error:` prefix is a convention this
 * server happens to follow; `isError` is what every client reads, and checking
 * only the text would let the flag be dropped without a single test noticing.
 */
export function isFailure(result: ToolResult): boolean {
  return result.isError === true && hasErrorFragment(result);
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
