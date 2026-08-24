import { z } from "zod";

/**
 * Validators shared by the register modules.
 *
 * The same four lines — a trimmed, non-empty string with a description and a
 * message — were written out nineteen times across the three modules. What
 * varies is exactly what the extraction takes as arguments: the description,
 * because it is what the calling model reads and the wording is deliberate
 * (`"Index name"` and `"Exact index name. No wildcard, no comma-separated
 * list."` say different things, and the second is a guardrail); and the
 * message, so a `reindex` validation error still says which of its two indices
 * was empty.
 */
export function requiredText(description: string, message: string) {
  return z.string().trim().min(1, message).describe(description);
}

/**
 * An index name. Fourteen of the nineteen sites, which is why it gets its own
 * name rather than every call site repeating the message.
 */
export function indexName(
  description: string,
  message = "Index name is required"
) {
  return requiredText(description, message);
}
