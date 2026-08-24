import { Client, estypes } from "@elastic/elasticsearch";
import { textFragment, toolError, type ToolResult } from "../toolResult.js";
import { budgeted } from "../outputBudget.js";

/**
 * An index's settings. `refresh_interval`, `number_of_replicas` and
 * `blocks.read_only_allow_delete` are the three that explain most "why is this
 * index slow / not searchable / refusing writes" questions.
 */
export async function getIndexSettings(
  esClient: Client,
  index: string
): Promise<ToolResult> {
  try {
    const response = await esClient.indices.getSettings<
      estypes.IndicesGetSettingsResponse
    >({ index });

    const settings = response.body[index]?.settings;

    if (!settings) {
      return budgeted({
        summary: [
          textFragment(
            `No settings returned for "${index}". It may be an alias or a pattern rather than a concrete index.`
          ),
        ],
        // Still structured, and still a success: the tool declares an
        // `outputSchema`, and the SDK rejects a successful result that omits the
        // payload. `found: false` is the honest way to say nothing came back.
        structured: () => ({ index, found: false }),
      });
    }

    return budgeted({
      summary: [
        textFragment(`Settings of "${index}"`),
        textFragment(JSON.stringify(settings, null, 2)),
      ],
      // `settings` is optional in the output schema, which is what lets it be
      // left out when it does not fit rather than pushing the result over the
      // budget it is measured against.
      structured: (room) =>
        Buffer.byteLength(JSON.stringify(settings), "utf8") < room
          ? { index, found: true, settings }
          : { index, found: true },
    });
  } catch (error) {
    return toolError("Get index settings failed", error);
  }
}

/**
 * Cluster settings that were overridden at runtime — a disabled allocation or a
 * lowered disk watermark lives here, and explains cluster-wide symptoms that no
 * index-level view accounts for. Defaults are excluded: they are large and
 * rarely the cause.
 */
export async function getClusterSettings(
  esClient: Client
): Promise<ToolResult> {
  try {
    const response = await esClient.cluster.getSettings<
      estypes.ClusterGetSettingsResponse
    >({ flat_settings: true });

    const { persistent, transient } = response.body;
    const isEmpty = (value: unknown) =>
      !value || Object.keys(value as Record<string, unknown>).length === 0;

    if (isEmpty(persistent) && isEmpty(transient)) {
      return {
        content: [
          textFragment(
            "No cluster setting has been overridden; everything is at its default."
          ),
        ],
      };
    }

    return {
      content: [
        textFragment(
          `Persistent: ${JSON.stringify(persistent ?? {}, null, 2)}`
        ),
        textFragment(`Transient: ${JSON.stringify(transient ?? {}, null, 2)}`),
      ],
    };
  } catch (error) {
    return toolError("Get cluster settings failed", error);
  }
}

/** Cluster name, Elasticsearch version and build flavour. */
export async function getClusterInfo(esClient: Client): Promise<ToolResult> {
  try {
    const response = await esClient.info<estypes.InfoResponse>();
    const info = response.body;

    return {
      content: [
        textFragment(
          `Cluster: ${info.cluster_name}\n` +
            `Elasticsearch: ${info.version.number} (${info.version.build_flavor})\n` +
            `Lucene: ${info.version.lucene_version}\n` +
            `Node answering: ${info.name}`
        ),
      ],
    };
  } catch (error) {
    return toolError("Get cluster info failed", error);
  }
}
