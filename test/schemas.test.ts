import { describe, expect, it } from "vitest";
import { indexName, requiredText } from "../src/register/schemas.js";

/**
 * The validator that nineteen registrations now share.
 *
 * Worth its own test precisely because it is shared: before the extraction each
 * site carried its own copy, so a lost `.trim()` would have broken one tool.
 * Now it would break all of them at once, and nothing else asserts it — zod
 * accepts `" logs "` as a non-empty string, and Elasticsearch answers 400 for an
 * index name with a leading space.
 */
describe("indexName", () => {
  it("trims, so a copy-pasted name with a space still resolves", () => {
    expect(indexName("Index name").parse("  logs-2026  ")).toBe("logs-2026");
  });

  it("rejects a name that is only whitespace", () => {
    const result = indexName("Index name").safeParse("   ");

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("Index name is required");
  });

  it("keeps the description, which is what the calling model reads", () => {
    // The wording differs between call sites on purpose — one of them is a
    // guardrail — which is why the builder takes it rather than fixing one.
    const guarded = indexName("Exact index name. No wildcard, no comma-separated list.");

    expect(guarded.description).toContain("No wildcard");
  });

  it("carries a message naming which field was empty", () => {
    // `reindex` takes two indices, so "Index name is required" would not say
    // which one the caller left out.
    const result = requiredText("Source index", "Source index name is required").safeParse("");

    expect(result.error?.issues[0]?.message).toBe("Source index name is required");
  });
});
