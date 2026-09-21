import { experimental_evaluate as evaluate } from "ai";
import { readEvaluationConfidence } from "../../../../lib/ai/confidence.ts";
import { evaluatorModel } from "../../../../lib/ai/evaluator-model.ts";
import { routeLanguage, type LanguageVerdict } from "./policy.ts";
import { LANGUAGE_QUESTIONS, type LanguageState } from "./questions.ts";

/**
 * Detects whether the user wrote in French, English, or something else, using one TypeSafe
 * `evaluate` request with a single Choice question. Deliberately coarse: only what the
 * assistant needs to pick a reply language.
 */
export async function detectLanguage(state: LanguageState): Promise<LanguageVerdict> {
  const { answers, providerMetadata } = await evaluate({
    model: evaluatorModel,
    state,
    questions: LANGUAGE_QUESTIONS,
  });

  const { choice, probabilities } = answers.language;
  return routeLanguage(
    choice,
    probabilities,
    readEvaluationConfidence(providerMetadata, "language"),
  );
}

export { replyLanguage } from "./policy.ts";
export type { DetectedLanguage, LanguageVerdict, ReplyLanguage } from "./policy.ts";
export type { LanguageState } from "./questions.ts";
