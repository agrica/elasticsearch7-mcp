import { Client, estypes } from "@elastic/elasticsearch";
import { textFragment, toolError, type ToolResult } from "../toolResult.js";
import { budgeted } from "../outputBudget.js";

/**
 * What fields exist across an index pattern, and what can be done with each.
 *
 * `get_mappings` needs a concrete index, which is the wrong shape for the
 * question that actually gets asked: over a year of daily indices, "does this
 * field exist, and can I aggregate on it" had no tool. `_field_caps` answers it
 * for a whole pattern in one request — and it is the only way to see a
 * **conflict**, where one field is mapped as two types across the pattern. That
 * is the case worth a tool, because it makes a query quietly wrong rather than
 * failing: the answer comes from the indices where the type agrees.
 */

/** `Indices` is `string | string[]`, so counting it needs normalising first. */
function asList(value: estypes.Indices | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function flag(value: boolean): string {
  return value ? "yes" : "no";
}

export async function fieldCaps(
  esClient: Client,
  index: string,
  fields?: string
): Promise<ToolResult> {
  try {
    const response = await esClient.fieldCaps<estypes.FieldCapsResponse>({
      index,
      // The API requires the parameter, and a wildcard is what "everything"
      // means here.
      fields: fields && fields.trim().length > 0 ? fields : "*",
    });

    const resolved = asList(response.body.indices);
    const entries = Object.entries(response.body.fields ?? {})
      // `_id`, `_index`, `_seq_no` and the rest are on every field list and are
      // never the question, so they are dropped rather than paid for on every
      // call. The API labels them, so this is not a name-matching heuristic.
      .filter(([, types]) =>
        Object.values(types).some((capability) => capability.metadata_field !== true)
      )
      .sort(([a], [b]) => a.localeCompare(b));

    const conflicts = entries.filter(([, types]) => Object.keys(types).length > 1);

    let headline =
      entries.length + " fields across " + resolved.length + " indices matching " + index;

    if (conflicts.length > 0) {
      headline +=
        "\n" + conflicts.length + " field" + (conflicts.length === 1 ? "" : "s") +
        " mapped as more than one type: " + conflicts.map(([name]) => name).join(", ") +
        "\nAn aggregation over one of those answers from the indices where the type " +
        "agrees, rather than failing — which is why this is reported first.";
    }

    const lines = entries.map(([name, types]) => {
      const rendered = Object.entries(types)
        .map(([type, capability]) => {
          const notes = [
            "searchable=" + flag(capability.searchable),
            "aggregatable=" + flag(capability.aggregatable),
          ];
          // Present only when the field is absent or differently mapped in part
          // of the pattern — and then it is the whole point, because
          // "aggregatable" over half the indices is the trap this tool exists
          // to expose.
          const partial = asList(capability.non_aggregatable_indices);
          if (partial.length > 0) {
            notes.push("not aggregatable in " + partial.length + " indices");
          }
          return type + " (" + notes.join(", ") + ")";
        })
        .join("  |  ");

      return textFragment(name + ": " + rendered);
    });

    return budgeted({
      summary: [textFragment(headline)],
      detail: lines,
      hint: "Pass `fields` with a name or a wildcard (`log.*`) to ask about fewer fields.",
    });
  } catch (error) {
    return toolError("Field capabilities lookup failed", error);
  }
}
