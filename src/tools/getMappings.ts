import { Client, estypes } from "@elastic/elasticsearch";
import { textFragment, toolError, type ToolResult } from "../toolResult.js";
import { budgeted, fitRecords } from "../outputBudget.js";
import { flattenFields } from "./mappingFields.js";

/**
 * The field mappings of one index.
 *
 * The answer a caller actually needs is which fields exist and of what type, so
 * that is the summary: one line per field, dotted paths, nested fields
 * included. The raw mapping follows as detail.
 *
 * That order is a **surface change**, and it is the same finding as everywhere
 * else in this file's neighbourhood: this tool used to return the whole mapping
 * pretty-printed and nothing else, unbudgeted. A logging index with a thousand
 * fields is around 80 KB of JSON that way — an unbounded result on a tool in the
 * default set, which the output budget had not covered because it was never
 * measured.
 */
export async function getMappings(
  esClient: Client,
  index: string
): Promise<ToolResult> {
  try {
    const mappingResponse = await esClient.indices.getMapping<
      estypes.IndicesGetMappingResponse
    >({
      index,
    });

    const mappings = mappingResponse.body[index]?.mappings ?? {};
    const fields = flattenFields(mappings.properties);
    const found = mappingResponse.body[index] !== undefined;

    const lines = fields
      .map((field) => `  ${field.path}: ${field.type}`)
      .join("\n");

    return budgeted({
      summary: [
        textFragment(
          found
            ? `Index "${index}": ${fields.length} fields` +
                (fields.length > 0 ? `\n${lines}` : "")
            : `No mapping returned for "${index}". A wildcard or an alias returns ` +
                `mappings keyed by the concrete indices it resolves to, not by the name given.`
        ),
      ],
      // The raw mapping is one object, so it is included or it is not — there is
      // no half a mapping worth having. The field listing above is what survives
      // a trim, which is the part a caller reasons about.
      detail: found
        ? [textFragment(`Raw mapping:\n${JSON.stringify(mappings, null, 2)}`)]
        : [],
      hint: "Name one concrete index to see its mapping.",
      // The flattened fields, not the raw mapping: a nested object of unbounded
      // size duplicated into the structured payload would buy nothing that the
      // tabular view does not already give, and would be charged against the
      // budget twice.
      structured: (room) => {
        const { included, omitted } = fitRecords(fields, room);
        return {
          index,
          found,
          total: fields.length,
          returned: included.length,
          omitted,
          fields: included,
        };
      },
    });
  } catch (error) {
    return toolError("Failed to get mapping", error);
  }
}
