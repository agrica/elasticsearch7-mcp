import { describe, expect, it } from "vitest";
import {
  createIndexTemplate,
  deleteIndexTemplate,
  getIndexTemplate,
} from "../src/tools/createIndexTemplate.js";
import { errors } from "@elastic/elasticsearch";
import {
  capture,
  createMockedClient,
  failEveryRoute,
  firstRequest,
  hasErrorFragment,
  textOf,
} from "./support/mockClient.js";

describe("createIndexTemplate", () => {
  it("wraps patterns, settings, mappings and aliases into a composable template", async () => {
    const { client, mock } = createMockedClient();
    const call = capture(mock, { method: "PUT", path: "/_index_template/logs" }, { acknowledged: true });

    const text = textOf(
      await createIndexTemplate(
        client,
        "logs",
        ["logs-*", "audit-*"],
        { settings: { number_of_shards: 1 } },
        100,
        2
      )
    );

    expect(firstRequest(call).body).toEqual({
      index_patterns: ["logs-*", "audit-*"],
      template: { settings: { number_of_shards: 1 }, mappings: {}, aliases: {} },
      priority: 100,
      version: 2,
    });
    expect(text).toContain('Index template "logs" created successfully.');
    expect(text).toContain("Index patterns: logs-*, audit-*");
    expect(text).toContain("acknowledged by the cluster");
  });

  it("omits priority and version when not supplied", async () => {
    const { client, mock } = createMockedClient();
    const call = capture(mock, { method: "PUT", path: "/_index_template/logs" }, { acknowledged: true });

    await createIndexTemplate(client, "logs", ["logs-*"], {});

    expect(firstRequest(call).body).not.toHaveProperty("priority");
    expect(firstRequest(call).body).not.toHaveProperty("version");
  });

  it("reports a cluster failure as an Error fragment", async () => {
    const { client, mock } = createMockedClient();
    failEveryRoute(mock);
    expect(hasErrorFragment(await createIndexTemplate(client, "logs", ["logs-*"], {}))).toBe(true);
  });
});

describe("getIndexTemplate", () => {
  it("lists every template when no name is given", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, { method: "GET", path: "/_index_template" }, {
      index_templates: [
        { name: "logs", index_template: { index_patterns: ["logs-*"], version: 2, priority: 100 } },
        { name: "audit", index_template: { index_patterns: ["audit-*"] } },
      ],
    });

    const text = textOf(await getIndexTemplate(client));

    expect(text).toContain("Template: logs");
    expect(text).toContain("Index patterns: logs-*");
    expect(text).toContain("Version: 2");
    // Missing fields are labelled rather than printed as undefined.
    expect(text).toContain("Template: audit");
    expect(text).toContain("Version: Not specified");
    expect(text).toContain("Priority: Not specified");
  });

  it("says so plainly when a named template does not exist", async () => {
    // Elasticsearch 7.x answers a missing named template with 404, not with an
    // empty list. The tool tolerates that status so the message below is a real
    // outcome rather than unreachable code.
    const { client, mock } = createMockedClient();
    mock.add(
      { method: "GET", path: "/_index_template/ghost" },
      () =>
        new errors.ResponseError({
          body: {
            error: {
              type: "resource_not_found_exception",
              reason: "index template matching [ghost] not found",
            },
            status: 404,
          },
          statusCode: 404,
          headers: {},
          warnings: null,
          meta: {},
        } as never)
    );

    const result = await getIndexTemplate(client, "ghost");

    expect(textOf(result)).toContain('No template found with name "ghost"');
    expect(hasErrorFragment(result)).toBe(false);
  });

  it("reports a cluster failure as an Error fragment", async () => {
    const { client, mock } = createMockedClient();
    failEveryRoute(mock);
    expect(hasErrorFragment(await getIndexTemplate(client, "logs"))).toBe(true);
  });
});

describe("deleteIndexTemplate", () => {
  it("confirms an acknowledged deletion", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, { method: "DELETE", path: "/_index_template/logs" }, { acknowledged: true });

    expect(textOf(await deleteIndexTemplate(client, "logs"))).toContain(
      'Index template "logs" deleted successfully.'
    );
  });

  it("warns when the cluster does not acknowledge", async () => {
    const { client, mock } = createMockedClient();
    capture(mock, { method: "DELETE", path: "/_index_template/logs" }, { acknowledged: false });

    expect(textOf(await deleteIndexTemplate(client, "logs"))).toContain("not acknowledged");
  });

  it("reports a cluster failure as an Error fragment", async () => {
    const { client, mock } = createMockedClient();
    failEveryRoute(mock);
    expect(hasErrorFragment(await deleteIndexTemplate(client, "logs"))).toBe(true);
  });
});
