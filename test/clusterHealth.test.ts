import { describe, expect, it } from "vitest";
import { getClusterHealth } from "../src/tools/getClusterHealth.js";
import {
  capture,
  createMockedClient,
  firstRequest,
  hasErrorFragment,
  textOf,
} from "./support/mockClient.js";

const HEALTH = {
  cluster_name: "logging-cluster",
  status: "green",
  timed_out: false,
  number_of_nodes: 3,
  number_of_data_nodes: 2,
  active_primary_shards: 10,
  active_shards: 20,
  relocating_shards: 0,
  initializing_shards: 1,
  unassigned_shards: 2,
  delayed_unassigned_shards: 0,
  number_of_pending_tasks: 4,
  number_of_in_flight_fetch: 0,
  task_max_waiting_in_queue_millis: 0,
  active_shards_percent_as_number: 100,
};

describe("getClusterHealth", () => {
  it("summarises the cluster at cluster level by default", async () => {
    const { client, mock } = createMockedClient();
    const call = capture(mock, { method: "GET", path: "/_cluster/health" }, HEALTH);

    const text = textOf(await getClusterHealth(client));

    expect(firstRequest(call).querystring.level).toBe("cluster");
    expect(text).toContain("Cluster Name: logging-cluster");
    expect(text).toContain("Status: green");
    expect(text).toContain("Nodes: 3");
    expect(text).toContain("Unassigned Shards: 2");
    expect(text).toContain("Pending Tasks: 4");
    expect(text).not.toContain("Indices Health Status");
  });

  it("asks for index-level detail and renders each index when requested", async () => {
    const { client, mock } = createMockedClient();
    const call = capture(mock, { method: "GET", path: "/_cluster/health" }, {
      ...HEALTH,
      indices: {
        "logs-2026": {
          status: "yellow",
          number_of_shards: 1,
          number_of_replicas: 1,
          active_primary_shards: 1,
          active_shards: 1,
          relocating_shards: 0,
          initializing_shards: 0,
          unassigned_shards: 1,
        },
      },
    });

    const text = textOf(await getClusterHealth(client, true));

    expect(firstRequest(call).querystring.level).toBe("indices");
    expect(text).toContain("Indices Health Status:");
    expect(text).toContain("Index: logs-2026");
    expect(text).toContain("Status: yellow");
  });

  it("reports a cluster failure as an Error fragment", async () => {
    const { client } = createMockedClient();
    const result = await getClusterHealth(client);

    expect(hasErrorFragment(result)).toBe(true);
    expect(textOf(result).startsWith("Error:")).toBe(true);
  });
});
