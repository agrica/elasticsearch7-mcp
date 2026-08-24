import { describe, expect, it } from "vitest";
import {
  INFO_7_8_0,
  createMockedClient,
} from "./support/mockClient.js";
import { capture, textOf } from "./support/mockClient.js";
import { getClusterHealth } from "../src/tools/getClusterHealth.js";

/**
 * The reason this project pins the 7.17 client. For a server older than 7.14
 * the client's product check reads `GET /` and validates the tagline and
 * build_flavor — there is no `x-elastic-product` header to rely on. An 8.x
 * client requires that header and sends `compatible-with=8` media types, so it
 * cannot talk to this cluster at all.
 */
describe("7.x cluster compatibility", () => {
  it("accepts a cluster that reports itself as 7.8.0 with the default build flavor", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, { method: "GET", path: "/_cluster/health" }, {
      cluster_name: "logging-cluster",
      status: "green",
      number_of_nodes: 3,
      number_of_data_nodes: 2,
      active_primary_shards: 1,
      active_shards: 1,
      relocating_shards: 0,
      initializing_shards: 0,
      unassigned_shards: 0,
      number_of_pending_tasks: 0,
    });

    // Succeeding at all means the product check passed against a 7.8 payload.
    expect(textOf(await getClusterHealth(client))).toContain("Cluster Name: logging-cluster");
  });

  it("describes the target cluster the tests simulate", () => {
    expect(INFO_7_8_0.version.number).toBe("7.8.0");
    expect(INFO_7_8_0.version.build_flavor).toBe("default");
    expect(INFO_7_8_0.tagline).toBe("You Know, for Search");
  });
});
