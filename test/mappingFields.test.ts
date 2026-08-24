import { describe, expect, it } from "vitest";
import { flattenFields, textFieldPaths } from "../src/tools/mappingFields.js";

/**
 * The walk two tools share. It is tested on its own because both callers depend
 * on the same two properties — dotted paths, and containers left out — and a
 * test through either tool would only prove it for that tool's question.
 */
describe("flattenFields", () => {
  it("names a nested field by the path a query would use", () => {
    expect(
      flattenFields({
        kubernetes: {
          properties: {
            pod: { properties: { name: { type: "text" }, uid: { type: "keyword" } } },
          },
        },
      })
    ).toEqual([
      { path: "kubernetes.pod.name", type: "text" },
      { path: "kubernetes.pod.uid", type: "keyword" },
    ]);
  });

  it("leaves out the containers, which are not fields anyone queries", () => {
    // `object` and `nested` nodes exist to hold other fields. Emitting them
    // would put `kubernetes: object` in a field listing, where it reads as a
    // field a caller could match on.
    const paths = flattenFields({
      explicit: { type: "object", properties: { leaf: { type: "long" } } },
      events: { type: "nested", properties: { at: { type: "date" } } },
      implicit: { properties: { leaf: { type: "long" } } },
    }).map((field) => field.path);

    expect(paths).toEqual(["explicit.leaf", "events.at", "implicit.leaf"]);
  });

  it("follows multi-fields, where the searchable copy of a keyword lives", () => {
    expect(
      flattenFields({
        command_line: { type: "keyword", fields: { text: { type: "text" } } },
      })
    ).toEqual([
      { path: "command_line", type: "keyword" },
      { path: "command_line.text", type: "text" },
    ]);
  });

  it("returns nothing for a mapping with no properties at all", () => {
    expect(flattenFields(undefined)).toEqual([]);
    expect(flattenFields({})).toEqual([]);
  });
});

describe("textFieldPaths", () => {
  it("keeps the text fields and nothing else, vectors included", () => {
    // A dense_vector cannot be highlighted, and neither can a keyword usefully.
    // Selecting `text` rather than excluding types by name is what makes that
    // true by construction instead of by a list someone has to maintain.
    expect(
      textFieldPaths({
        message: { type: "text" },
        level: { type: "keyword" },
        embedding: { type: "dense_vector", dims: 384 },
        nested: { properties: { body: { type: "text" } } },
      })
    ).toEqual(["message", "nested.body"]);
  });
});
