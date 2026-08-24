/**
 * Cluster-scale fixtures: a year of daily indices, which is the shape that made
 * the unbounded output measurable in the first place.
 *
 * Shared between the scale test and `scripts/measure-output.mjs` so the figures
 * quoted in `docs/architecture-review-2026-08-24.md` can be re-run rather than
 * rebuilt. Rebuilding them by hand is how the numbers in a review quietly stop
 * matching the code.
 */

/** Daily indices for a year, sized like a real logging cluster. */
export function dailyIndices(count = 365) {
  return Array.from({ length: count }, (_, i) => ({
    index: `logs-2025.${String((i % 12) + 1).padStart(2, "0")}.${String(
      (i % 28) + 1
    ).padStart(2, "0")}`,
    health: "green",
    status: "open",
    pri: "3",
    rep: "1",
    "docs.count": String(4_000_000 + i),
    "docs.deleted": "120",
    "store.size": String(3_500_000_000 + i),
    "pri.store.size": String(1_700_000_000 + i),
    uuid: `uuid-${i}`,
  }));
}

/** Three primaries and one replica each: 2190 shards for 365 indices. */
export function shardsFor(indices: ReturnType<typeof dailyIndices>) {
  return indices.flatMap((index) =>
    [0, 1, 2].flatMap((shard) =>
      ["p", "r"].map((prirep) => ({
        index: index.index,
        shard: String(shard),
        prirep,
        state: "STARTED",
        docs: "1333333",
        store: "1166666666",
        node: `es-node-${(shard % 3) + 1}`,
      }))
    )
  );
}

/** Log hits with a realistic message and stack trace, not short strings. */
export function logHits(count = 500) {
  return Array.from({ length: count }, (_, i) => ({
    _index: "logs",
    _id: String(i),
    _score: 1,
    _source: {
      "@timestamp": "2026-08-24T10:00:00Z",
      level: "ERROR",
      host: `srv-${i % 20}`,
      message:
        `Connection pool exhausted while acquiring a lease for tenant ${i} ` +
        `after 30000ms; retrying`,
      stack:
        "at com.example.Pool.acquire(Pool.java:142)\n" +
        "\tat com.example.Svc.run(Svc.java:88)",
    },
  }));
}

export function nodesFor(count = 24) {
  return Array.from({ length: count }, (_, i) => ({
    name: `es-node-${i + 1}`,
    "node.role": "dilm",
    master: i === 0 ? "*" : "-",
    "heap.percent": "71",
    "ram.percent": "94",
    cpu: "35",
    load_1m: "1.20",
    "disk.used_percent": "88.4",
    "disk.avail": "12884901888",
  }));
}

/**
 * Bytes a tool result would put into the caller's context.
 *
 * Both halves count. `structuredContent` travels with the result and reaches the
 * model exactly as the text does, so measuring only the fragments would report a
 * result as half its size the moment a tool gained an output schema — which is
 * precisely the regression the budget exists to prevent.
 */
export function resultBytes(result: {
  content: { text: string }[];
  structuredContent?: Record<string, unknown>;
}): number {
  const structured = result.structuredContent
    ? Buffer.byteLength(JSON.stringify(result.structuredContent), "utf8")
    : 0;
  return textBytes(result) + structured;
}

/** Bytes of the text fragments alone, when a test is about what a human reads. */
export function textBytes(result: { content: { text: string }[] }): number {
  return Buffer.byteLength(result.content.map((f) => f.text).join("\n"), "utf8");
}
