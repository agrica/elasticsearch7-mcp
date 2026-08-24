import { Client, estypes } from "@elastic/elasticsearch";
import { textFragment, toolError, type ToolResult } from "../toolResult.js";

export async function createMapping(
  esClient: Client,
  index: string,
  mappings: estypes.MappingTypeMapping
): Promise<ToolResult> {
  try {
    // The 7.x client casts HEAD responses to a boolean, so a missing index
    // yields `false` here instead of throwing on the 404.
    const indexExists = await esClient.indices.exists<boolean>({ index });

    const content: ToolResult["content"] = [];

    if (!indexExists.body) {
      await esClient.indices.create({
        index,
        body: { mappings },
      });

      content.push(
        textFragment(
          `Index "${index}" does not exist. Created new index and applied mapping.`
        )
      );
    } else {
      // putMapping takes the mapping as the body itself, not wrapped.
      await esClient.indices.putMapping({
        index,
        body: mappings,
      });

      content.push(textFragment(`Updated mapping for index "${index}".`));
    }

    // Echo back what the cluster now holds. getMapping keys its response by
    // concrete index names, so this is absent when `index` is an alias, a
    // wildcard or date math — the write above still succeeded, and reporting it
    // as a failure would be wrong.
    const updatedMappings = await esClient.indices.getMapping<
      estypes.IndicesGetMappingResponse
    >({ index });

    const currentMapping = updatedMappings.body[index]?.mappings;

    content.push(
      textFragment(
        currentMapping
          ? `\nCurrent mapping structure:\n${JSON.stringify(currentMapping, null, 2)}`
          : `\nMapping applied. The cluster returned no mapping for "${index}" — expected when it is an alias or a pattern rather than a concrete index.`
      )
    );

    return { content };
  } catch (error) {
    return toolError("Failed to set mapping", error);
  }
}
