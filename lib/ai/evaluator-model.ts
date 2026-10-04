import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";
import type { Experimental_EvaluationModel as EvaluationModel } from "ai";
import { requireEnv } from "../env.ts";

/**
 * Which System One backend answers `experimental_evaluate` calls:
 * - `typesafe`: TypeSafe's hosted Jev (default).
 * - `ollama`: a decision model from the Ollama library (Clef-flash, Clef, Nimble, Tev1) on
 *   Ollama's native /v1/systemone (see infra/ollama), at `OLLAMA_BASE_URL`.
 * - `laya`: self-hosted laya-serve (see infra/laya), which speaks the same /v1/systemone protocol.
 * - `local`: any other self-hosted /v1/systemone server — e.g. Kev (infra/kev) — at
 *   `EVALUATOR_BASE_URL`, serving `EVALUATOR_MODEL_ID`.
 */
export type EvaluatorBackend = "typesafe" | "ollama" | "laya" | "local";

const EVALUATOR_BACKENDS: readonly EvaluatorBackend[] = ["typesafe", "ollama", "laya", "local"];

/** Ollama's Clef-flash: the smallest CUDA tag it publishes (see docs/BENCHMARK_RESULTS.md). */
const DEFAULT_OLLAMA_MODEL_ID = "clef-flash:9b-q8_0";

function resolveEvaluatorBackend(): EvaluatorBackend {
  const value = process.env.EVALUATOR_BACKEND?.trim() || "typesafe";
  if (!(EVALUATOR_BACKENDS as readonly string[]).includes(value)) {
    throw new Error(
      `Invalid EVALUATOR_BACKEND: ${value}. Expected one of: ${EVALUATOR_BACKENDS.join(", ")}.`,
    );
  }
  return value as EvaluatorBackend;
}

export const EVALUATOR_BACKEND = resolveEvaluatorBackend();

export interface EvaluatorModelOptions {
  /** Server root including the version segment, e.g. `http://localhost:8010/v1`. */
  readonly baseURL: string;
  readonly modelId: string;
  /** Self-hosted servers only check it when configured to; the provider insists on one regardless. */
  readonly apiKey?: string;
  /** Swapped in by the benchmark to time each round trip. */
  readonly fetch?: typeof globalThis.fetch;
}

/** A System One evaluation model on any /v1/systemone-compatible server. */
export function createEvaluatorModel(options: EvaluatorModelOptions): EvaluationModel {
  return createTypeSafeAi({
    baseURL: options.baseURL,
    apiKey: options.apiKey || "local",
    fetch: options.fetch,
  }).evaluationModel(options.modelId);
}

function configuredEvaluator(): { modelId: string; provider: ReturnType<typeof createTypeSafeAi> } {
  switch (EVALUATOR_BACKEND) {
    case "laya":
      // Laya's root id, which laya-serve treats as "let the router pick the English or
      // multilingual checkpoint".
      return {
        modelId: "convaiinnovations/laya",
        provider: createTypeSafeAi({
          baseURL: process.env.LAYA_BASE_URL?.trim() || "http://localhost:8000/v1",
          // The provider insists on a key; laya-serve only checks it when LAYA_API_KEY is set.
          apiKey: process.env.LAYA_API_KEY?.trim() || "laya-local",
        }),
      };
    case "ollama":
      return {
        modelId: process.env.EVALUATOR_MODEL_ID?.trim() || DEFAULT_OLLAMA_MODEL_ID,
        provider: createTypeSafeAi({
          baseURL: process.env.OLLAMA_BASE_URL?.trim() || "http://localhost:11434/v1",
          // The provider insists on a key; Ollama ignores it.
          apiKey: "ollama",
        }),
      };
    case "local":
      return {
        modelId: requireEnv("EVALUATOR_MODEL_ID").trim(),
        provider: createTypeSafeAi({
          baseURL: requireEnv("EVALUATOR_BASE_URL").trim(),
          apiKey: process.env.EVALUATOR_API_KEY?.trim() || "local",
        }),
      };
    case "typesafe":
      // TypeSafe's flagship System One model.
      return {
        modelId: "jev-latest",
        provider: createTypeSafeAi({ apiKey: requireEnv("TYPESAFE_AI_API_KEY") }),
      };
  }
}

const configured = configuredEvaluator();

/** The model id `evaluatorModel` asks the configured backend for. */
export const EVALUATOR_MODEL_ID = configured.modelId;

/** Configured TypeSafe provider, exposed so callers can pick other model ids. */
export const typeSafeAiProvider = configured.provider;

/** The default evaluator model used with `experimental_evaluate`. */
export const evaluatorModel = typeSafeAiProvider.evaluationModel(EVALUATOR_MODEL_ID);
