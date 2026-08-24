import { describe, expect, it } from "vitest";
import { analyze } from "../src/tools/analyze.js";
import {
  capture,
  createMockedClient,
  failEveryRoute,
  firstRequest,
  hasErrorFragment,
  isFailure,
  textOf,
} from "./support/mockClient.js";

const INDEXED = { method: ["GET", "POST"], path: "/logs/_analyze" };
const CLUSTER = { method: ["GET", "POST"], path: "/_analyze" };

function tokens(words: string[]) {
  return {
    tokens: words.map((token, position) => ({
      token,
      start_offset: position * 5,
      end_offset: position * 5 + token.length,
      type: "<ALPHANUM>",
      position,
    })),
  };
}

describe("analyze", () => {
  it("sends the text under body, with the field when one is given", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, INDEXED, tokens(["connection", "refused"]));

    await analyze(client, "Connection Refused", { index: "logs", field: "message" });
    const request = firstRequest(captured);

    expect(request.body).toEqual({ text: "Connection Refused", field: "message" });
  });

  it("uses a named analyzer without an index", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, CLUSTER, tokens(["connection"]));

    await analyze(client, "Connection", { analyzer: "standard" });

    expect(firstRequest(captured).body).toEqual({
      text: "Connection",
      analyzer: "standard",
    });
  });

  it("leads with the terms, which is the answer", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, INDEXED, tokens(["connection", "refus"]));

    const text = textOf(
      await analyze(client, "Connection refused", { index: "logs", field: "message" })
    );

    expect(text).toContain("2 tokens from field message on logs");
    expect(text).toContain("Terms: connection | refus");
    // Why the caller is reading this at all: a query matches only if its own
    // analysis lands on one of these.
    expect(text).toContain("A query matches only if");
    expect(text).toContain("[0] connection");
  });

  /**
   * `field` is resolved against an index mapping, so one without the other is a
   * request the cluster answers with a 400 that does not name the missing half.
   */
  it("refuses a field without an index, and says which half is missing", async () => {
    const { client, mock } = createMockedClient();
    const captured = capture(mock, CLUSTER, tokens([]));

    const result = await analyze(client, "text", { field: "message" });

    expect(isFailure(result)).toBe(true);
    expect(textOf(result)).toContain("`field` needs `index`");
    expect(captured.requests).toHaveLength(0);
  });

  it("returns the failure as content rather than throwing", async () => {
    const { client, mock } = createMockedClient();
    failEveryRoute(mock);

    const result = await analyze(client, "text", { index: "logs" });

    expect(hasErrorFragment(result)).toBe(true);
    expect(result.isError).toBe(true);
  });
});
