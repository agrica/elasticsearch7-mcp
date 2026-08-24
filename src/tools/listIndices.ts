import { Client, estypes } from "@elastic/elasticsearch";
import { textFragment, toolError, type ToolResult } from "../toolResult.js";
import { budgeted, chunkedJson } from "../outputBudget.js";

/**
 * List Elasticsearch indices, optionally filtered.
 *
 * `pattern` reaches the cat API as an Elasticsearch wildcard (`log-*`), not a
 * regex, despite what the tool description says.
 */
export async function listIndices(
  esClient: Client,
  pattern?: string,
  verbose?: boolean
): Promise<ToolResult> {
  try {
    const response = await esClient.cat.indices<
      estypes.CatIndicesIndicesRecord[]
    >({
      format: "json",
      index: pattern || "*",
      // Sizes in bytes, so a caller can compare them instead of parsing "4.7gb".
      bytes: "b",
    });

    const indicesInfo = response.body.map((index) => ({
      index: index.index,
      health: index.health,
      status: index.status,
      // The cat API returns dotted keys; the camelCase aliases exist only in
      // the type definitions and are undefined at runtime.
      docsCount: index["docs.count"],
      storeSizeBytes: index["store.size"],
    }));

    // One line per index rather than pretty-printed JSON. On 365 daily indices
    // that is the difference between roughly 22 KB and 54 KB, for the same five
    // facts — and the pretty JSON was the only content this tool returned, so
    // the size was not optional detail, it was the answer.
    const lines = indicesInfo
      .map(
        (index) =>
          `${index.index}  ${index.health ?? "?"} ${index.status ?? "?"}  ` +
          `docs=${index.docsCount ?? "?"}  bytes=${index.storeSizeBytes ?? "?"}`
      )
      .join("\n");

    const unhealthy = indicesInfo.filter(
      (index) => index.health !== "green" && index.health !== undefined
    );

    return budgeted({
      summary: [
        textFragment(
          `Found ${indicesInfo.length} indices` +
            (unhealthy.length > 0
              ? `, ${unhealthy.length} not green: ${unhealthy
                  .map((index) => `${index.index} (${index.health})`)
                  .join(", ")}`
              : "")
        ),
        textFragment(lines),
      ],
      // The raw JSON is a superset of the lines above, so it is detail: worth
      // having when a caller wants to parse it, first to go when space runs out.
      detail: verbose ? chunkedJson(indicesInfo) : [],
      hint: "Narrow `pattern` (e.g. `logs-2026.08.*`) to see fewer indices.",
    });
  } catch (error) {
    return toolError("Failed to list indices", error);
  }
}
