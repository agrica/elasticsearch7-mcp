import { describe, expect, it } from "vitest";
import { getMappings } from "../src/tools/getMappings.js";
import { createMapping } from "../src/tools/createMapping.js";
import type { estypes } from "@elastic/elasticsearch";
import {
  capture,
  createMockedClient,
  firstRequest,
  hasErrorFragment,
  textOf,
} from "./support/mockClient.js";

describe("getMappings", () => {
  it("unwraps the mapping through `.body[index].mappings`", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, { method: "GET", path: "/logs/_mapping" }, {
      logs: { mappings: { properties: { message: { type: "text" } } } },
    });

    const text = textOf(await getMappings(client, "logs"));

    expect(text).toContain("Index mapping: logs");
    expect(text).toContain('"message"');
    expect(text).toContain('"type": "text"');
  });

  it("falls back to an empty object when the index key is absent", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, { method: "GET", path: "/logs/_mapping" }, {});
    expect(textOf(await getMappings(client, "logs"))).toContain("mapping: {}");
  });

  it("reports a cluster failure as an Error fragment", async () => {
    const { client } = createMockedClient();
    expect(hasErrorFragment(await getMappings(client, "logs"))).toBe(true);
  });
});

describe("createMapping", () => {
  // Annotated, so the fixture itself is checked against Elasticsearch's
  // mapping types rather than being a loose object literal.
  const MAPPINGS: estypes.MappingTypeMapping = {
    properties: { level: { type: "keyword" } },
  };

  it("updates the mapping when the index exists", async () => {
    const { client, mock } = createMockedClient();
    mock.add({ method: "HEAD", path: "/logs" }, () => "");
    const put = capture(mock, { method: "PUT", path: "/logs/_mapping" }, { acknowledged: true });
    capture(mock, { method: "GET", path: "/logs/_mapping" }, { logs: { mappings: MAPPINGS } });

    const text = textOf(await createMapping(client, "logs", MAPPINGS));

    // putMapping takes the mapping as the body itself, not wrapped in `mappings`.
    expect(firstRequest(put).body).toEqual(MAPPINGS);
    expect(text).toContain('Updated mapping for index "logs"');
    expect(text).toContain("Current mapping structure:");
  });

  it("creates the index when it does not exist — a HEAD 404 must not throw", async () => {
    // The 7.x client casts HEAD responses to a boolean and ignores a 404, which
    // is what makes this branch reachable at all. No HEAD route is registered,
    // so the mock answers 404.
    const { client, mock } = createMockedClient();
    const create = capture(mock, { method: "PUT", path: "/fresh" }, {
      acknowledged: true,
      shards_acknowledged: true,
      index: "fresh",
    });
    capture(mock, { method: "GET", path: "/fresh/_mapping" }, { fresh: { mappings: MAPPINGS } });

    const text = textOf(await createMapping(client, "fresh", MAPPINGS));

    expect(firstRequest(create).body).toEqual({ mappings: MAPPINGS });
    expect(text).toContain('Index "fresh" does not exist. Created new index');
  });

  it("reports a cluster failure as an Error fragment", async () => {
    const { client, mock } = createMockedClient();
    mock.add({ method: "HEAD", path: "/logs" }, () => "");
    // PUT is left unregistered, so the mapping update fails.
    expect(hasErrorFragment(await createMapping(client, "logs", MAPPINGS))).toBe(true);
  });
});
