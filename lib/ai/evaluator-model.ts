import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";
import { requireEnv } from "../env.ts";

/**
 * Which System One backend answers `experimental_evaluate` calls:
 * - `typesafe`: TypeSafe's hosted Jev (default).
 * - `laya`: self-hosted laya-serve (see infra/laya), which speaks the same /v1/systemone protocol.
 */
export type EvaluatorBackend = "typesafe" | "laya";

function resolveEvaluatorBackend(): EvaluatorBackend {
  const value = process.env.EVALUATOR_BACKEND?.trim() || "typesafe";
  if (value !== "typesafe" && value !== "laya") {
    throw new Error(`Invalid EVALUATOR_BACKEND: ${value}. Expected "typesafe" or "laya".`);
  }
  return value;
}

export const EVALUATOR_BACKEND = resolveEvaluatorBackend();

/**
 * TypeSafe's flagship System One model, or Laya's root id, which laya-serve treats as
 * "let the router pick the English or multilingual checkpoint".
 */
export const EVALUATOR_MODEL_ID =
  EVALUATOR_BACKEND === "laya" ? "convaiinnovations/laya" : "jev-latest";

/** Configured TypeSafe provider, exposed so callers can pick other model ids. */
export const typeSafeAiProvider =
  EVALUATOR_BACKEND === "laya"
    ? createTypeSafeAi({
        baseURL: process.env.LAYA_BASE_URL?.trim() || "http://localhost:8000/v1",
        // The provider insists on a key; laya-serve only checks it when LAYA_API_KEY is set.
        apiKey: process.env.LAYA_API_KEY?.trim() || "laya-local",
      })
    : createTypeSafeAi({
        apiKey: requireEnv("TYPESAFE_AI_API_KEY"),
      });

/** The default evaluator model used with `experimental_evaluate`. */
export const evaluatorModel = typeSafeAiProvider.evaluationModel(EVALUATOR_MODEL_ID);
