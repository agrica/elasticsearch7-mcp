import { describe, expect, it } from "vitest";
import {
  budgeted,
  DEFAULT_MAX_RESULT_BYTES,
  setResultBudget,
} from "../src/outputBudget.js";
import { textFragment } from "../src/toolResult.js";

/**
 * The budget exists because one `list_shards` call was measured returning
 * 385 469 bytes. What it must never do is trim silently: a model handed a
 * shortened list with no notice concludes the entry it wanted does not exist,
 * which is a wrong answer rather than a partial one.
 */
describe("budgeted", () => {
  it("returns everything when it fits, and adds nothing", () => {
    const result = budgeted({
      summary: [textFragment("2 shards")],
      detail: [textFragment("shard detail")],
      hint: "unused",
      maxBytes: 1000,
    });

    expect(result.content.map((f) => f.text)).toEqual(["2 shards", "shard detail"]);
  });

  it("drops detail before summary, and says how much went", () => {
    const result = budgeted({
      summary: [textFragment("SUMMARY")],
      detail: [textFragment("x".repeat(400)), textFragment("y".repeat(400))],
      hint: "Pass an index.",
      maxBytes: 500,
    });

    const text = result.content.map((f) => f.text).join("\n");

    expect(text).toContain("SUMMARY");
    expect(text).toContain("1 of 2 detail sections omitted");
    // The hint is the actionable half: a caller told only that data was cut
    // cannot do anything about it.
    expect(text).toContain("Pass an index.");
  });

  it("keeps the summary and truncates it rather than dropping it", () => {
    // A cluster with thousands of unassigned shards produces a summary that is
    // itself over budget. Losing it would lose the answer.
    const result = budgeted({
      summary: [textFragment("Not started:\n" + "row\n".repeat(500))],
      maxBytes: 600,
    });

    const text = result.content.map((f) => f.text).join("\n");

    expect(text).toContain("Not started:");
    expect(text).toContain("truncated");
    expect(text).toContain("the summary was truncated");
  });

  it("never exceeds the budget by more than the notice it appends", () => {
    const budget = 800;
    const result = budgeted({
      summary: [textFragment("head")],
      detail: Array.from({ length: 40 }, (_, i) => textFragment(`row ${i} `.repeat(20))),
      hint: "Narrow the call.",
      maxBytes: budget,
    });

    const size = Buffer.byteLength(result.content.map((f) => f.text).join(""), "utf8");

    // The notice is allowed to overshoot: reporting the omission matters more
    // than the last hundred bytes of the ceiling.
    expect(size).toBeLessThan(budget + 300);
  });

  it("says nothing about the budget when nothing was cut", () => {
    const result = budgeted({
      summary: [textFragment("all good")],
      detail: [textFragment("detail")],
      hint: "Pass an index.",
      maxBytes: 10_000,
    });

    expect(result.content.map((f) => f.text).join("\n")).not.toContain("Result budget");
  });

  it("takes the configured budget when a call does not name one", () => {
    setResultBudget(300);
    try {
      const result = budgeted({
        summary: [textFragment("head")],
        detail: [textFragment("z".repeat(500))],
      });

      expect(result.content.map((f) => f.text).join("\n")).toContain("omitted");
    } finally {
      // Module state: leaving it changed would make later tests depend on the
      // order this file ran in.
      setResultBudget(DEFAULT_MAX_RESULT_BYTES);
    }
  });
});
