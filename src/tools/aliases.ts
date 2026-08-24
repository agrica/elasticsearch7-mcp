import { Client, estypes } from "@elastic/elasticsearch";
import { textFragment, toolError, type ToolResult } from "../toolResult.js";

/**
 * Which aliases point where. A caller needs this to know whether a name it is
 * about to query is a concrete index or an alias — which changes what
 * `get_mappings` returns, and what a write would hit.
 */
export async function getAliases(
  esClient: Client,
  index?: string
): Promise<ToolResult> {
  try {
    const response = await esClient.indices.getAlias<
      estypes.IndicesGetAliasResponse
    >({ ...(index ? { index } : {}) }, { ignore: [404] });

    const entries = Object.entries(response.body).filter(
      ([, value]) => value && typeof value === "object" && "aliases" in value
    );

    if (entries.length === 0) {
      return {
        content: [
          textFragment(
            index
              ? `No alias found for "${index}".`
              : "No alias defined on this cluster."
          ),
        ],
      };
    }

    const described = entries.flatMap(([indexName, value]) => {
      const aliases = Object.keys(value.aliases ?? {});
      return aliases.length > 0
        ? [`${indexName} <- ${aliases.join(", ")}`]
        : [];
    });

    return {
      content: [
        textFragment(`${described.length} indices carry an alias`),
        textFragment(described.join("\n") || "none"),
      ],
    };
  } catch (error) {
    return toolError("Get aliases failed", error);
  }
}
