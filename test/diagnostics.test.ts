import { describe, expect, it } from "vitest";
import {
  explainAllocation,
  getIndexStats,
  getNodeStats,
  listNodes,
  listShards,
} from "../src/tools/diagnostics.js";
import {
  getClusterInfo,
  getClusterSettings,
  getIndexSettings,
} from "../src/tools/settings.js";
import { listTasks } from "../src/tools/tasks.js";
import {
  capture,
  createMockedClient,
  failEveryRoute,
  firstRequest,
  isFailure,
  textOf,
} from "./support/mockClient.js";

/**
 * The diagnostic tools exist to answer "why is this index unhealthy" from a
 * production cluster the caller cannot log into. What matters is that the
 * blocker reaches the model: a decider saying NO, a shard that is not STARTED,
 * a disk watermark. A tool that fetched the right data and then summarised the
 * healthy half of it would be useless while looking like it worked.
 */
describe("explain_allocation", () => {
  it("surfaces the reason and the deciders that said no", async () => {
    const { client, mock } = createMockedClient();
    const call = capture(
      mock,
      { method: ["GET", "POST"], path: "/_cluster/allocation/explain" },
      {
        index: "logs-2026",
        shard: 2,
        primary: false,
        current_state: "unassigned",
        unassigned_info: {
          reason: "NODE_LEFT",
          details: "node_left [abc123]",
        },
        allocate_explanation:
          "cannot allocate because allocation is not permitted to any of the nodes",
        node_allocation_decisions: [
          {
            node_name: "es-node-2",
            node_decision: "no",
            deciders: [
              { decider: "same_shard", decision: "YES", explanation: "fine" },
              {
                decider: "disk_threshold",
                decision: "NO",
                explanation: "the node is above the high watermark",
              },
            ],
          },
        ],
      }
    );

    const text = textOf(await explainAllocation(client, "logs-2026", 2, false));

    expect(firstRequest(call).body).toEqual({
      index: "logs-2026",
      shard: 2,
      primary: false,
    });
    expect(text).toContain("logs-2026[2] replica: unassigned");
    expect(text).toContain("NODE_LEFT");
    expect(text).toContain("node_left [abc123]");
    expect(text).toContain("es-node-2 -> no");
    // The blocker, and only the blocker: a YES decider is noise here.
    expect(text).toContain("disk_threshold: the node is above the high watermark");
    expect(text).not.toContain("same_shard");
  });

  it("asks about an arbitrary unassigned shard when given no index", async () => {
    const { client, mock } = createMockedClient();
    const call = capture(
      mock,
      { method: ["GET", "POST"], path: "/_cluster/allocation/explain" },
      { index: "logs", shard: 0, primary: true, current_state: "started" }
    );

    await explainAllocation(client);

    // No body at all — Elasticsearch then picks an unassigned shard itself.
    // Sending `{index: undefined}` would be a 400 instead.
    expect(firstRequest(call).body).toBeNull();
    expect(firstRequest(call).querystring.include_disk_info).toBe("true");
  });
});

describe("list_shards", () => {
  it("leads with the shards that are not started", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, { method: "GET", path: "/_cat/shards" }, [
      {
        index: "logs-2026",
        shard: "0",
        prirep: "p",
        state: "STARTED",
        node: "es-node-1",
      },
      {
        index: "logs-2026",
        shard: "1",
        prirep: "r",
        state: "UNASSIGNED",
        "unassigned.reason": "NODE_LEFT",
      },
    ]);

    const text = textOf(await listShards(client));

    expect(text).toContain("2 shards, 1 not STARTED");
    expect(text).toContain("logs-2026[1] r UNASSIGNED — NODE_LEFT");
    // The raw dump is no longer returned unless asked for: it is what let this
    // tool answer with 385 KB on a 2190-shard cluster.
    expect(text).not.toContain('"prirep": "p"');
  });

  it("returns the raw dump only when verbose is set, after the summary", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, { method: "GET", path: "/_cat/shards" }, [
      { index: "logs-2026", shard: "0", prirep: "p", state: "STARTED", node: "es-node-1" },
      { index: "logs-2026", shard: "1", prirep: "r", state: "UNASSIGNED", "unassigned.reason": "NODE_LEFT" },
    ]);

    const text = textOf(await listShards(client, undefined, true));

    expect(text).toContain('"prirep": "p"');
    // Order still matters: a client that truncates keeps the part that counts.
    expect(text.indexOf("Not started:")).toBeLessThan(text.indexOf('"prirep": "p"'));
  });

  it("asks for bytes rather than human units", async () => {
    const { client, mock } = createMockedClient();
    const call = capture(mock, { method: "GET", path: "/_cat/shards/logs" }, []);

    await listShards(client, "logs");

    // "3.2gb" cannot be compared or summed by the calling model.
    expect(firstRequest(call).querystring.bytes).toBe("b");
    expect(firstRequest(call).querystring.format).toBe("json");
  });
});

describe("get_index_stats", () => {
  it("reports the counters that explain a slow index", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, { method: "GET", path: "/logs/_stats" }, {
      indices: {
        logs: {
          total: {
            docs: { count: 1200, deleted: 30 },
            store: { size_in_bytes: 4096 },
            segments: { count: 7 },
            indexing: {
              index_total: 500,
              index_time_in_millis: 900,
              index_failed: 2,
            },
            search: { query_total: 88, query_time_in_millis: 1200 },
            merges: { total: 4, total_time_in_millis: 300 },
            refresh: { total: 60, total_time_in_millis: 150 },
          },
        },
      },
    });

    const text = textOf(await getIndexStats(client, "logs"));

    expect(text).toContain("Documents: 1200 (30 deleted)");
    expect(text).toContain("500 ops, 900ms, 2 failed");
    expect(text).toContain("88 queries, 1200ms");
  });

  it("explains an empty result instead of reporting nothing", async () => {
    // Asking for an alias or a pattern returns stats under the concrete index
    // names, so the lookup by the requested name misses. Silence would read as
    // "this index is empty".
    const { client, mock } = createMockedClient();
    capture(mock, { method: "GET", path: "/logs-alias/_stats" }, {
      indices: { "logs-2026": { total: { docs: { count: 1 } } } },
    });

    const text = textOf(await getIndexStats(client, "logs-alias"));

    expect(text).toContain("alias or a pattern");
    expect(text).not.toContain("Error:");
  });
});

describe("list_nodes", () => {
  it("reports heap, cpu and disk pressure per node", async () => {
    const { client, mock } = createMockedClient();
    const call = capture(mock, { method: "GET", path: "/_cat/nodes" }, [
      {
        name: "es-node-1",
        "node.role": "dilm",
        master: "*",
        "heap.percent": "71",
        "ram.percent": "94",
        cpu: "35",
        load_1m: "1.20",
        "disk.used_percent": "88.4",
        "disk.avail": "12884901888",
      },
    ]);

    const text = textOf(await listNodes(client));

    expect(text).toContain("1 nodes");
    expect(text).toContain("es-node-1 [dilm] (master)");
    expect(text).toContain("heap 71%");
    expect(text).toContain("disk used 88.4%");
    // Dotted keys are the real cat API field names; the camelCase aliases in
    // CatNodesNodesRecord exist only in the type.
    expect(firstRequest(call).querystring.h).toContain("disk.used_percent");
  });
});

describe("get_index_settings", () => {
  it("returns the settings under the requested index", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, { method: "GET", path: "/logs/_settings" }, {
      logs: {
        settings: {
          index: { refresh_interval: "30s", number_of_replicas: "1" },
        },
      },
    });

    const text = textOf(await getIndexSettings(client, "logs"));

    expect(text).toContain('Settings of "logs"');
    expect(text).toContain('"refresh_interval": "30s"');
  });
});

describe("get_cluster_settings", () => {
  it("says so plainly when nothing has been overridden", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, { method: "GET", path: "/_cluster/settings" }, {
      persistent: {},
      transient: {},
    });

    const text = textOf(await getClusterSettings(client));

    expect(text).toContain("everything is at its default");
  });

  it("shows an override that would explain a cluster-wide symptom", async () => {
    const { client, mock } = createMockedClient();
    const call = capture(mock, { method: "GET", path: "/_cluster/settings" }, {
      persistent: { "cluster.routing.allocation.enable": "none" },
      transient: {},
    });

    const text = textOf(await getClusterSettings(client));

    // Flat settings keep the key readable as the operator wrote it, instead of
    // nesting it five levels deep.
    expect(firstRequest(call).querystring.flat_settings).toBe("true");
    expect(text).toContain("cluster.routing.allocation.enable");
    expect(text).toContain("none");
  });
});

describe("cluster_info", () => {
  it("reads the version and build flavour off GET /", async () => {
    const { client } = createMockedClient();

    const text = textOf(await getClusterInfo(client));

    expect(text).toContain("7.8.0 (default)");
    expect(text).toContain("logging-cluster");
  });
});

describe("list_tasks", () => {
  it("filters by action and lists the running tasks", async () => {
    const { client, mock } = createMockedClient();
    const call = capture(mock, { method: "GET", path: "/_tasks" }, {
      nodes: {
        node1: {
          name: "es-node-1",
          tasks: {
            "node1:42": {
              node: "node1",
              id: 42,
              action: "indices:data/write/reindex",
              running_time_in_nanos: 5_000_000_000,
              cancellable: true,
            },
          },
        },
      },
    });

    const text = textOf(await listTasks(client, "*reindex*"));

    expect(firstRequest(call).querystring.actions).toBe("*reindex*");
    expect(firstRequest(call).querystring.detailed).toBe("true");
    expect(text).toContain("node1:42");
    expect(text).toContain("indices:data/write/reindex");
  });
});

/**
 * Node stats answer the three questions `_cat/nodes` cannot: is the JVM
 * spending its time collecting garbage, is work queueing or being rejected, and
 * has a circuit breaker fired. All three are counters cumulative since the node
 * started, which is the trap this tool exists to avoid walking into: a number
 * with no uptime beside it reads as "right now" to a calling model.
 */
const NODE_STATS_FIXTURE = {
  _nodes: { total: 2, successful: 2, failed: 0 },
  cluster_name: "logging-cluster",
  nodes: {
    aaaaaaaaaaaaaaaaaaaaaa: {
      name: "es-node-1",
      jvm: {
        uptime_in_millis: 3_542_400_000,
        mem: {
          heap_used_in_bytes: 25_891_534_848,
          heap_used_percent: 78,
          heap_max_in_bytes: 33_285_996_544,
        },
        gc: {
          collectors: {
            young: { collection_count: 118_432, collection_time_in_millis: 1_260_000 },
            old: { collection_count: 2431, collection_time_in_millis: 94_000 },
          },
        },
      },
      thread_pool: {
        write: { active: 4, queue: 12, rejected: 128, completed: 900, threads: 8 },
        search: { active: 0, queue: 0, rejected: 0, completed: 500, threads: 13 },
        force_merge: { active: 0, queue: 0, rejected: 0, completed: 3, threads: 1 },
      },
      breakers: {
        parent: { tripped: 3, limit_size_in_bytes: 31_621_696_716 },
        fielddata: { tripped: 0, limit_size_in_bytes: 13_314_398_617 },
      },
    },
    bbbbbbbbbbbbbbbbbbbbbb: {
      name: "es-node-2",
      jvm: {
        uptime_in_millis: 3_542_400_000,
        mem: {
          heap_used_in_bytes: 13_314_398_617,
          heap_used_percent: 41,
          heap_max_in_bytes: 33_285_996_544,
        },
        gc: {
          collectors: {
            young: { collection_count: 90_210, collection_time_in_millis: 1_020_000 },
            old: { collection_count: 812, collection_time_in_millis: 31_000 },
          },
        },
      },
      thread_pool: {
        write: { active: 0, queue: 0, rejected: 0, completed: 640, threads: 8 },
        search: { active: 0, queue: 0, rejected: 0, completed: 480, threads: 13 },
      },
      breakers: {
        parent: { tripped: 0, limit_size_in_bytes: 31_621_696_716 },
        fielddata: { tripped: 0, limit_size_in_bytes: 13_314_398_617 },
      },
    },
  },
};

describe("get_node_stats", () => {
  it("asks for jvm, thread_pool and breaker only", async () => {
    const { client, mock } = createMockedClient();
    const call = capture(
      mock,
      { method: "GET", path: "/_nodes/stats/*" },
      NODE_STATS_FIXTURE
    );

    await getNodeStats(client);

    // The path carries the metric filter, and the filter is the whole reason
    // this is one cheap call: a bare `_nodes/stats` also returns `indices`,
    // which is the bulk of the payload and answers none of these questions.
    const path = decodeURIComponent(firstRequest(call).path);
    expect(path).toContain("jvm");
    expect(path).toContain("thread_pool");
    expect(path).toContain("breaker");
    expect(path).not.toContain("indices");
  });

  it("gives every node a heap and GC line, quiet ones included", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, { method: "GET", path: "/_nodes/stats/*" }, NODE_STATS_FIXTURE);

    const text = textOf(await getNodeStats(client));

    // Nodes are the bounded dimension — tens, not thousands — so none is ever
    // filtered out. A node missing from the answer would read as a node that is
    // fine, which is the failure mode this whole file is written against.
    expect(text).toContain("es-node-1");
    expect(text).toContain("es-node-2");
    expect(text).toContain("heap 78%");
    expect(text).toContain("heap 41%");
    expect(text).toContain("old 812");
  });

  it("names the counters cumulative and gives each node's uptime", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, { method: "GET", path: "/_nodes/stats/*" }, NODE_STATS_FIXTURE);

    const text = textOf(await getNodeStats(client));

    // 3 542 400 000 ms is 41 days. Without it beside them, 128 rejections read
    // as "the cluster is rejecting writes" rather than "it did, at some point
    // in the last six weeks".
    expect(text).toContain("41d");
    expect(text).toContain("cumulative");
  });

  it("shows a thread pool with rejections and hides the idle ones", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, { method: "GET", path: "/_nodes/stats/*" }, NODE_STATS_FIXTURE);

    const text = textOf(await getNodeStats(client));

    expect(text).toContain("write: active 4, queue 12, rejected 128");
    // Pools are the unbounded dimension: around twenty per node. Selecting them
    // by "not idle" rather than by a name list is what keeps a saturated
    // force_merge visible without anyone having to add it to a whitelist.
    expect(text).not.toContain("force_merge");
    expect(text).not.toContain("search:");
  });

  it("shows a tripped breaker and hides the ones that never fired", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, { method: "GET", path: "/_nodes/stats/*" }, NODE_STATS_FIXTURE);

    const text = textOf(await getNodeStats(client));

    expect(text).toContain("breaker parent: tripped 3");
    expect(text).not.toContain("fielddata");
  });

  it("counts the nodes under pressure so an absence is a number", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, { method: "GET", path: "/_nodes/stats/*" }, NODE_STATS_FIXTURE);

    const text = textOf(await getNodeStats(client));

    // "2 nodes" alone would leave a caller unable to tell a quiet cluster from
    // a tool that dropped the interesting half.
    expect(text).toContain("2 nodes");
    expect(text).toContain("1 with queued or rejected work");
    expect(text).toContain("1 with a tripped breaker");
  });

  it("dumps the full per-node stats behind verbose", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, { method: "GET", path: "/_nodes/stats/*" }, NODE_STATS_FIXTURE);

    const text = textOf(await getNodeStats(client, true));

    // force_merge is idle, so the summary omits it. Verbose means "give me the
    // rows", including the idle ones a caller may want to rule out.
    expect(text).toContain("force_merge");
    expect(text).toContain("completed");
  });

  it("reports a cluster error as a failed result, not a throw", async () => {
    const { client, mock } = createMockedClient();
    failEveryRoute(mock);

    const result = await getNodeStats(client);

    // The context string goes to stderr only: an ES client error carries the
    // connection in `meta`, and a node URL may embed credentials.
    expect(isFailure(result)).toBe(true);
    expect(textOf(result)).toContain("Error:");
  });
});
