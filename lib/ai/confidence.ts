import type { ProviderMetadata } from "ai";

/**
 * Reads a Choice/Score answer's confidence from TypeSafe's `providerMetadata`
 * (`providerMetadata.typesafe.confidence[questionId]`, per the TypeSafe provider docs).
 * Boolean (Noul) answers have no confidence field — only a `probability` — so this
 * always returns `undefined` for them.
 */
export function readEvaluationConfidence(
  metadata: ProviderMetadata | undefined,
  questionId: string,
): number | undefined {
  const confidence = metadata?.["typesafe"]?.["confidence"];
  if (typeof confidence !== "object" || confidence === null || Array.isArray(confidence)) {
    return undefined;
  }
  const value = (confidence as Record<string, unknown>)[questionId];
  return typeof value === "number" ? value : undefined;
}
