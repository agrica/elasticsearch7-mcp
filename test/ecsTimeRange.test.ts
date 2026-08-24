import { describe, expect, it } from "vitest";
import {
  resolveBound,
  suggestInterval,
  windowMinutes,
} from "../src/tools/ecs/timeRange.js";

describe("resolveBound", () => {
  it("turns a bare duration into date math", () => {
    expect(resolveBound("15m", "since")).toEqual({ ok: true, value: "now-15m" });
    expect(resolveBound("2h", "since")).toEqual({ ok: true, value: "now-2h" });
    expect(resolveBound("7d", "since")).toEqual({ ok: true, value: "now-7d" });
    expect(resolveBound("30s", "since")).toEqual({ ok: true, value: "now-30s" });
    expect(resolveBound("1w", "since")).toEqual({ ok: true, value: "now-1w" });
  });

  it("passes date math through untouched", () => {
    expect(resolveBound("now-1d", "since")).toEqual({ ok: true, value: "now-1d" });
    expect(resolveBound("now-1d/d", "since")).toEqual({ ok: true, value: "now-1d/d" });
    expect(resolveBound("now", "until")).toEqual({ ok: true, value: "now" });
  });

  it("passes an absolute date through untouched", () => {
    expect(resolveBound("2026-08-25", "since")).toEqual({
      ok: true,
      value: "2026-08-25",
    });
    expect(resolveBound("2026-08-25T10:00:00Z", "until")).toEqual({
      ok: true,
      value: "2026-08-25T10:00:00Z",
    });
    // Epoch milliseconds, which Elasticsearch accepts on a date field.
    expect(resolveBound("1756100000000", "since")).toEqual({
      ok: true,
      value: "1756100000000",
    });
  });

  it("trims, because a value pasted into a config carries whitespace", () => {
    expect(resolveBound("  15m  ", "since")).toEqual({ ok: true, value: "now-15m" });
  });

  /**
   * The important half. A window is exactly what a caller cannot verify by
   * reading the answer, so a value that is not understood must be refused rather
   * than interpreted — and the refusal names the parameter and the forms.
   */
  it("refuses anything else, naming the parameter", () => {
    for (const bad of ["yesterday", "15 minutes", "-15m", "15", "m15", ""]) {
      const result = resolveBound(bad, "since");
      expect(result.ok, `"${bad}" should be refused`).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("`since`");
        expect(result.reason).toContain("15m");
      }
    }
  });
});

describe("windowMinutes", () => {
  it("measures the shorthand", () => {
    expect(windowMinutes("15m")).toBe(15);
    expect(windowMinutes("2h")).toBe(120);
    expect(windowMinutes("7d")).toBe(10_080);
    expect(windowMinutes("1w")).toBe(10_080);
    expect(windowMinutes("30s")).toBe(0.5);
  });

  it("cannot measure what is not a duration", () => {
    // Deliberate: measuring `now-1d/d` or an absolute range needs the clock, and
    // a tool that reads the clock has tests that depend on when they run.
    expect(windowMinutes("now-1d")).toBeUndefined();
    expect(windowMinutes("2026-08-25")).toBeUndefined();
  });
});

describe("suggestInterval", () => {
  it("aims at a readable number of buckets", () => {
    expect(suggestInterval("15m")).toBe("1m");
    expect(suggestInterval("30m")).toBe("1m");
    expect(suggestInterval("1h")).toBe("5m");
    expect(suggestInterval("6h")).toBe("30m");
    expect(suggestInterval("1d")).toBe("1h");
    expect(suggestInterval("7d")).toBe("6h");
    expect(suggestInterval("30d")).toBe("1d");
  });

  it("falls back to an hour when the window cannot be measured", () => {
    expect(suggestInterval("now-1d/d")).toBe("1h");
  });

  it("keeps every bucket count within an order of magnitude of thirty", () => {
    // The property the ladder exists for, asserted rather than the ladder's
    // literal contents: a width nobody can read is the failure, not a
    // particular number.
    for (const window of ["15m", "1h", "6h", "1d", "7d", "14d"]) {
      const minutes = windowMinutes(window) ?? 0;
      const width = windowMinutes(suggestInterval(window)) ?? 1;
      const buckets = minutes / width;
      expect(buckets, `${window} gives ${buckets} buckets`).toBeGreaterThanOrEqual(5);
      expect(buckets, `${window} gives ${buckets} buckets`).toBeLessThanOrEqual(120);
    }
  });
});
