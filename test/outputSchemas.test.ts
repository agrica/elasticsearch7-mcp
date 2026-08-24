import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  GET_INDEX_SETTINGS_OUTPUT,
  GET_MAPPINGS_OUTPUT,
  LIST_INDICES_OUTPUT,
  LIST_SHARDS_OUTPUT,
} from "../src/register/outputSchemas.js";
import { listIndices } from "../src/tools/listIndices.js";
import { listShards } from "../src/tools/diagnostics.js";
import { getIndexSettings } from "../src/tools/settings.js";
import { getMappings } from "../src/tools/getMappings.js";
import { capture, createMockedClient } from "./support/mockClient.js";

/**
 * The declared schema against the payload the tool actually produces.
 *
 * This is the check the SDK runs on every successful call of a tool that
 * declares an `outputSchema` — and it answers with a protocol error rather than
 * a tool result, so a mismatch does not degrade gracefully. Asserting it here
 * means a field renamed in a tool fails a test instead of a session.
 */
function validate(shape: z.ZodRawShape, payload: unknown) {
  const result = z.object(shape).safeParse(payload);
  expect(
    result.success ? [] : result.error.issues,
    "the tool's structured payload does not match its declared output schema"
  ).toEqual([]);
}

describe("structured output matches the declared schema", () => {
  it("list_indices", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, { method: "GET", path: "/_cat/indices/logs-*" }, [
      {
        index: "logs-2026.08.24",
        health: "yellow",
        status: "open",
        "docs.count": "4000",
        "store.size": "512000",
      },
    ]);

    const result = await listIndices(client, "logs-*");

    validate(LIST_INDICES_OUTPUT, result.structuredContent);
    expect(result.structuredContent).toMatchObject({
      pattern: "logs-*",
      total: 1,
      returned: 1,
      omitted: 0,
    });
  });

  it("list_shards, including the dotted unassigned.reason key", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, { method: "GET", path: "/_cat/shards/logs-2026.08.24" }, [
      {
        index: "logs-2026.08.24",
        shard: "0",
        prirep: "r",
        state: "UNASSIGNED",
        "unassigned.reason": "NODE_LEFT",
      },
    ]);

    const result = await listShards(client, "logs-2026.08.24");

    validate(LIST_SHARDS_OUTPUT, result.structuredContent);
    // The reason survives validation: a strict object would have stripped the
    // one field a caller reads when a shard is not started.
    expect(result.structuredContent).toMatchObject({
      index: "logs-2026.08.24",
      notStarted: 1,
      shards: [{ "unassigned.reason": "NODE_LEFT" }],
    });
  });

  it("get_index_settings, present and absent", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, { method: "GET", path: "/logs/_settings" }, {
      logs: { settings: { index: { number_of_replicas: "1" } } },
    });
    validate(
      GET_INDEX_SETTINGS_OUTPUT,
      (await getIndexSettings(client, "logs")).structuredContent
    );

    const absent = createMockedClient();
    capture(absent.mock, { method: "GET", path: "/gone/_settings" }, {});
    const result = await getIndexSettings(absent.client, "gone");

    // The not-found branch is a *success*, so it needs a payload too: the SDK
    // rejects a successful result without one once a schema is declared.
    validate(GET_INDEX_SETTINGS_OUTPUT, result.structuredContent);
    expect(result.structuredContent).toEqual({ index: "gone", found: false });
  });

  it("get_mappings", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, { method: "GET", path: "/logs/_mapping" }, {
      logs: { mappings: { properties: { message: { type: "text" } } } },
    });

    validate(
      GET_MAPPINGS_OUTPUT,
      (await getMappings(client, "logs")).structuredContent
    );
  });
});
