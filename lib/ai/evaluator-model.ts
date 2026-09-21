import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";
import { requireEnv } from "../env.ts";

/** TypeSafe's flagship System One model: typed judgments and probabilities, not text. */
export const EVALUATOR_MODEL_ID = "jev-latest";

/** Configured TypeSafe provider, exposed so callers can pick other model ids. */
export const typeSafeAiProvider = createTypeSafeAi({
  apiKey: requireEnv("TYPESAFE_AI_API_KEY"),
});

/** The default evaluator model used with `experimental_evaluate`. */
export const evaluatorModel = typeSafeAiProvider.evaluationModel(EVALUATOR_MODEL_ID);
