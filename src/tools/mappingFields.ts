/**
 * Walking a mapping, which two tools need and neither owns.
 *
 * `search` wants the text fields, to build a highlight block. `get_mappings`
 * wants every field, to summarise an index in a line each rather than a
 * pretty-printed blob. Both questions are the same walk, so it lives here.
 */

/**
 * The three keys of a mapping node this walk cares about.
 *
 * Described structurally rather than as `estypes.MappingProperty`: that type is
 * a union of some forty variants, and narrowing it to reach `properties` costs
 * more than it proves. The shape below is the part of the mapping format that
 * has been stable since 2.x.
 */
type MappingNode = {
  type?: string;
  properties?: Record<string, MappingNode>;
  fields?: Record<string, MappingNode>;
};

export type MappedField = { path: string; type: string };

/**
 * Flatten a mapping's `properties` into one entry per leaf field, named by its
 * dotted path.
 *
 * Recursion is the whole point. The previous version of the highlight scan read
 * top-level `properties` only, so on a mapping with `kubernetes.pod.name` as
 * `text` — which is what a logging mapping looks like — that field was absent
 * from the highlight block, and the feature mostly did not fire on the indices
 * it existed for.
 *
 * `fields` is followed too, because a multi-field is where the searchable copy
 * of a keyword lives: ECS maps `process.command_line` as `keyword` with a
 * `text` sub-field at `process.command_line.text`, and that sub-field is the
 * one a full-text query matches.
 *
 * Object and nested containers are not themselves emitted — only what they
 * contain. A caller asking which fields an index has does not mean the
 * intermediate nodes.
 */
export function flattenFields(properties: unknown, prefix = ""): MappedField[] {
  // One cast, at the boundary, for the reason given on MappingNode.
  const nodes = (properties ?? {}) as Record<string, MappingNode>;
  const fields: MappedField[] = [];

  for (const [name, node] of Object.entries(nodes)) {
    if (!node || typeof node !== "object") continue;

    const path = prefix ? `${prefix}.${name}` : name;
    const isContainer = node.type === undefined || node.type === "object" || node.type === "nested";

    if (!isContainer) fields.push({ path, type: node.type as string });
    if (node.properties) fields.push(...flattenFields(node.properties, path));
    if (node.fields) fields.push(...flattenFields(node.fields, path));
  }

  return fields;
}

/** The dotted paths of every `text` field, which are the highlightable ones. */
export function textFieldPaths(properties: unknown): string[] {
  return flattenFields(properties)
    .filter((field) => field.type === "text")
    .map((field) => field.path);
}
