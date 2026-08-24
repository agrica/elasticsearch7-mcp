import { Client, estypes } from "@elastic/elasticsearch";
import { textFragment, toolError, type ToolResult } from "../toolResult.js";

export async function createIndexTemplate(
  esClient: Client,
  name: string,
  indexPatterns: string[],
  template: estypes.IndicesPutIndexTemplateIndexTemplateMapping,
  priority?: number,
  version?: number
): Promise<ToolResult> {
  try {
    const body: NonNullable<estypes.IndicesPutIndexTemplateRequest["body"]> = {
      index_patterns: indexPatterns,
      template: {
        settings: template.settings || {},
        mappings: template.mappings || {},
        aliases: template.aliases || {},
      },
    };

    if (priority !== undefined) {
      body.priority = priority;
    }

    if (version !== undefined) {
      body.version = version;
    }

    const response = await esClient.indices.putIndexTemplate<
      estypes.IndicesPutIndexTemplateResponse
    >({
      name,
      body,
    });

    return {
      content: [
        textFragment(`Index template "${name}" created successfully.`),
        textFragment(`Index patterns: ${indexPatterns.join(", ")}`),
        textFragment(
          response.body.acknowledged
            ? "Template was acknowledged by the cluster."
            : "Template was not acknowledged. Check cluster status."
        ),
      ],
    };
  } catch (error) {
    return toolError("Create index template failed", error);
  }
}

export async function getIndexTemplate(
  esClient: Client,
  name?: string
): Promise<ToolResult> {
  try {
    const params: { name?: string } = {};
    if (name) {
      params.name = name;
    }

    // Elasticsearch answers a missing named template with 404. Tolerating it
    // turns that into the "no template found" message below instead of an
    // `Error:` fragment — the body then carries no templates, hence Partial.
    const response = await esClient.indices.getIndexTemplate<
      Partial<estypes.IndicesGetIndexTemplateResponse>
    >(params, { ignore: [404] });

    const templates = response.body.index_templates ?? [];
    const content: ToolResult["content"] = templates.map((template) => {
      const patterns = template.index_template.index_patterns || [];
      const version = template.index_template.version || "Not specified";
      const priority = template.index_template.priority || "Not specified";

      const patternsText = Array.isArray(patterns)
        ? patterns.join(", ")
        : patterns;

      return textFragment(
        `Template: ${template.name}\nIndex patterns: ${patternsText}\nVersion: ${version}\nPriority: ${priority}\n`
      );
    });

    if (content.length === 0) {
      content.push(
        textFragment(
          name
            ? `No template found with name "${name}"`
            : "No index templates found"
        )
      );
    }

    return { content };
  } catch (error) {
    return toolError("Get index template failed", error);
  }
}

export async function deleteIndexTemplate(
  esClient: Client,
  name: string
): Promise<ToolResult> {
  try {
    const response = await esClient.indices.deleteIndexTemplate<
      estypes.AcknowledgedResponseBase
    >({
      name,
    });

    return {
      content: [
        textFragment(
          response.body.acknowledged
            ? `Index template "${name}" deleted successfully.`
            : `Index template delete request sent, but not acknowledged. Check cluster status.`
        ),
      ],
    };
  } catch (error) {
    return toolError("Delete index template failed", error);
  }
}
