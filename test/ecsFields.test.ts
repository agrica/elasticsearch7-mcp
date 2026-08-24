import { describe, expect, it } from "vitest";
import {
  KEYWORD_FIELDS,
  RENDERED_FIELDS,
  STACK_TRACE,
  knownLevels,
  levelTerms,
  minLevelTerms,
} from "../src/tools/ecs/fields.js";

describe("levelTerms", () => {
  it("expands a level to the spellings of its own rank", () => {
    const terms = levelTerms(["error"]);
    // Same severity, different libraries: java.util.logging writes SEVERE.
    expect(terms).toContain("ERROR");
    expect(terms).toContain("error");
    expect(terms).toContain("Error");
    expect(terms).toContain("SEVERE");
    // And not a different severity.
    expect(terms).not.toContain("WARN");
    expect(terms).not.toContain("FATAL");
  });

  it("ignores the case it is given", () => {
    expect(levelTerms(["ERROR"])).toEqual(levelTerms(["error"]));
    expect(levelTerms(["  Error  "])).toEqual(levelTerms(["error"]));
  });

  /**
   * The half that matters more. A cluster may index a level the ladder has never
   * heard of, and dropping it would return nothing while looking like a filter
   * that worked.
   */
  it("passes an unknown level through exactly as given", () => {
    expect(levelTerms(["AUDIT"])).toEqual(["AUDIT"]);
    expect(levelTerms(["notice_2"])).toEqual(["notice_2"]);
  });

  it("keeps both when a known and an unknown level are asked for", () => {
    const terms = levelTerms(["AUDIT", "fatal"]);
    expect(terms).toContain("AUDIT");
    expect(terms).toContain("FATAL");
  });

  it("deduplicates, since aliases overlap", () => {
    expect(new Set(levelTerms(["error", "severe"])).size).toBe(
      levelTerms(["error", "severe"]).length
    );
  });
});

describe("minLevelTerms", () => {
  it("includes every rank at or above", () => {
    const terms = minLevelTerms("warn") ?? [];
    expect(terms).toContain("WARN");
    expect(terms).toContain("WARNING");
    expect(terms).toContain("ERROR");
    expect(terms).toContain("SEVERE");
    expect(terms).toContain("FATAL");
    expect(terms).toContain("CRITICAL");
    // And nothing below it.
    expect(terms).not.toContain("INFO");
    expect(terms).not.toContain("DEBUG");
    expect(terms).not.toContain("TRACE");
  });

  it("puts TRACE at the bottom, so it admits everything", () => {
    const terms = minLevelTerms("trace") ?? [];
    expect(terms).toContain("TRACE");
    expect(terms).toContain("FATAL");
  });

  it("cannot order a level it does not know, and says so by returning nothing", () => {
    // The caller is then told to use `levels` with the exact value — a filter
    // silently meaning something else is the failure being avoided.
    expect(minLevelTerms("AUDIT")).toBeUndefined();
  });
});

describe("the field constants", () => {
  it("names the ECS 1.x keyword fields the module filters on", () => {
    expect(Object.values(KEYWORD_FIELDS)).toEqual([
      "log.level",
      "log.logger",
      "service.name",
      "service.environment",
      "host.name",
      "error.type",
      "event.dataset",
      "trace.id",
    ]);
  });

  it("keeps the stack trace out of the default field list", () => {
    // Requested only when it will be printed: it is the largest field in an ECS
    // error document, so asking for it by default is the difference between an
    // answer and an exhausted budget.
    expect(RENDERED_FIELDS).not.toContain(STACK_TRACE);
    expect(RENDERED_FIELDS).toContain("@timestamp");
    expect(RENDERED_FIELDS).toContain("error.message");
  });

  it("reports the canonical level names for a refusal message", () => {
    expect(knownLevels()).toEqual(["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"]);
  });
});
