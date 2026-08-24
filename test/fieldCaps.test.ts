import { describe, expect, it } from "vitest";
import { fieldCaps } from "../src/tools/fieldCaps.js";
import {
  capture,
  createMockedClient,
  failEveryRoute,
  firstRequest,
  hasErrorFragment,
  textOf,
} from "./support/mockClient.js";

const ROUTE = { method: ["GET", "POST"], path: "/logs-app-*/_field_caps" };

describe("fieldCaps", () => {
  it("asks for every field unless told otherwise", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, { indices: [], fields: {} });

    await fieldCaps(client, "logs-app-*");

    expect(firstRequest(captured).querystring["fields"]).toBe("*");
  });

  it("passes a field pattern through", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, ROUTE, { indices: [], fields: {} });

    await fieldCaps(client, "logs-app-*", "log.*");

    expect(firstRequest(captured).querystring["fields"]).toBe("log.*");
  });

  it("lists each field with what can be done to it", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, ROUTE, {
      indices: ["logs-app-2026.08.24", "logs-app-2026.08.25"],
      fields: {
        "log.level": { keyword: { type: "keyword", searchable: true, aggregatable: true } },
        message: { text: { type: "text", searchable: true, aggregatable: false } },
      },
    });

    const text = textOf(await fieldCaps(client, "logs-app-*"));

    expect(text).toContain("2 fields across 2 indices");
    expect(text).toContain("log.level: keyword (searchable=yes, aggregatable=yes)");
    expect(text).toContain("message: text (searchable=yes, aggregatable=no)");
  });

  it("leads with a field mapped as two types, because that is the silent one", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, ROUTE, {
      indices: ["logs-app-2026.08.24", "logs-app-2026.08.25"],
      fields: {
        "http.response.status_code": {
          long: { type: "long", searchable: true, aggregatable: true },
          keyword: { type: "keyword", searchable: true, aggregatable: true },
        },
      },
    });

    const text = textOf(await fieldCaps(client, "logs-app-*"));

    // An aggregation over it answers from the indices where the type agrees,
    // rather than failing — which is why this is the finding worth a tool.
    expect(text).toContain("1 field mapped as more than one type");
    expect(text).toContain("http.response.status_code");
    expect(text).toContain("answers from the indices where the type");
    expect(text).toContain("long (");
    expect(text).toContain("keyword (");
  });

  it("says when a field is aggregatable over only part of the pattern", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, ROUTE, {
      indices: ["a", "b", "c"],
      fields: {
        "service.name": {
          keyword: {
            type: "keyword",
            searchable: true,
            aggregatable: true,
            non_aggregatable_indices: ["b", "c"],
          },
        },
      },
    });

    expect(textOf(await fieldCaps(client, "logs-app-*"))).toContain(
      "not aggregatable in 2 indices"
    );
  });

  it("handles indices arriving as a single string", async () => {
    // `Indices` is `string | string[]` in the client's own types, so counting it
    // without normalising would report the length of the name.
    const { client, mock } = createMockedClient();
    capture(mock, ROUTE, {
      indices: "logs-app-2026.08.25",
      fields: { message: { text: { type: "text", searchable: true, aggregatable: false } } },
    });

    expect(textOf(await fieldCaps(client, "logs-app-*"))).toContain("across 1 indices");
  });

  it("drops metadata fields, which are on every list and never the question", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, ROUTE, {
      indices: ["a"],
      fields: {
        _id: { _id: { type: "_id", searchable: true, aggregatable: false, metadata_field: true } },
        _index: {
          _index: { type: "_index", searchable: true, aggregatable: true, metadata_field: true },
        },
        message: { text: { type: "text", searchable: true, aggregatable: false } },
      },
    });

    const text = textOf(await fieldCaps(client, "logs-app-*"));

    expect(text).toContain("1 fields across");
    expect(text).not.toContain("_id:");
  });

  it("returns the failure as content rather than throwing", async () => {
    const { client, mock } = createMockedClient();
    failEveryRoute(mock);

    const result = await fieldCaps(client, "logs-app-*");

    expect(hasErrorFragment(result)).toBe(true);
    expect(result.isError).toBe(true);
  });
});
