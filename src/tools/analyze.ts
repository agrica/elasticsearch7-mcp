import { Client, estypes } from "@elastic/elasticsearch";
import { textFragment, toolError, toolRefusal, type ToolResult } from "../toolResult.js";
import { budgeted } from "../outputBudget.js";

/**
 * Why a query does not match.
 *
 * This is the question that follows a search returning nothing, and until now it
 * had no answer: analysis is invisible from the outside, so a caller could see
 * that `Connection refused` did not match a document containing exactly that
 * text without any way to find out that the field's analyser had lowercased,
 * split and stemmed both sides differently.
 *
 * Passing `field` rather than `analyzer` is the useful form, because it uses the
 * analyser the index actually applies to that field rather than one the caller
 * guessed at.
 */
export async function analyze(
  esClient: Client,
  text: string,
  options: { index?: string; field?: string; analyzer?: string } = {}
): Promise<ToolResult> {
  const { index, field, analyzer } = options;

  // `field` is resolved against an index's mapping, so one without the other is
  // a request the cluster answers with a 400. Saying so here names the missing
  // half, which the cluster's message does not.
  if (field !== undefined && field.trim().length > 0 && !index) {
    return toolRefusal(
      "`field` needs `index`: the analyser comes from that index's mapping. " +
        "Pass both, or pass `analyzer` to test a named analyser without an index."
    );
  }

  try {
    const body: NonNullable<estypes.IndicesAnalyzeRequest["body"]> = { text };
    if (field !== undefined && field.trim().length > 0) body.field = field;
    if (analyzer !== undefined && analyzer.trim().length > 0) body.analyzer = analyzer;

    const response = await esClient.indices.analyze<estypes.IndicesAnalyzeResponse>(
      index ? { index, body } : { body }
    );

    const tokens = response.body.tokens ?? [];

    const summary = [
      textFragment(
        tokens.length + " tokens from " +
          (field ? "field " + field : analyzer ? "analyzer " + analyzer : "the standard analyzer") +
          (index ? " on " + index : "") + ".\n" +
          "Terms: " + tokens.map((token) => token.token).join(" | ") + "\n" +
          "A query matches only if its own analysis produces one of these terms."
      ),
    ];

    const lines = tokens.map((token) =>
      textFragment(
        "[" + token.position + "] " + token.token +
          "  offsets " + token.start_offset + "-" + token.end_offset +
          "  type=" + token.type
      )
    );

    return budgeted({
      summary,
      detail: lines,
      hint: "Analyze a shorter `text` to return fewer tokens.",
    });
  } catch (error) {
    return toolError("Analyze failed", error);
  }
}
