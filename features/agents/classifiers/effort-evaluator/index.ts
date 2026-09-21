import { experimental_evaluate as evaluate } from "ai";
import { readEvaluationConfidence } from "../../../../lib/ai/confidence.ts";
import { evaluatorModel } from "../../../../lib/ai/evaluator-model.ts";
import type { ReasoningEffort } from "../../../../lib/ai/effort.ts";
import { routeEffort, type EffortVerdict } from "./policy.ts";
import { EFFORT_QUESTIONS, type EffortState } from "./questions.ts";

export interface EvaluateEffortInput {
  /** The user's request. */
  readonly prompt: string;
  /** What the assistant answering `prompt` is for, in a sentence or two. */
  readonly assistantPurpose: string;
  /** The tools available to the assistant, briefly described. */
  readonly availableTools: string;
  /** The caller's resolved ladder — fed to the model as context and quantized onto. */
  readonly efforts: readonly ReasoningEffort[];
}

/**
 * Judges how much effort a downstream model should spend answering `input.prompt`, using
 * one batched TypeSafe `evaluate` request: four independent Score dimensions plus three
 * Boolean overrides over the same shared state, composed into one verdict by `policy.ts`.
 *
 * `input.efforts` is used to build the shared state (`supportedEfforts`) and passed
 * straight through to `routeEffort` as the quantization ladder — one array, so the rungs
 * the model reasons about and the rungs the verdict can land on cannot drift apart.
 */
export async function evaluateEffort(input: EvaluateEffortInput): Promise<EffortVerdict> {
  const state: EffortState = {
    prompt: input.prompt,
    assistantPurpose: input.assistantPurpose,
    availableTools: input.availableTools,
    supportedEfforts: input.efforts.join(", "),
  };

  const { answers, providerMetadata } = await evaluate({
    model: evaluatorModel,
    state,
    questions: EFFORT_QUESTIONS,
  });

  const dimensions = {
    taskComplexity: answers.taskComplexity.score,
    ambiguity: answers.ambiguity.score,
    researchBreadth: answers.researchBreadth.score,
    stakes: answers.stakes.score,
  };
  const overrides = {
    isTrivialLookup: answers.isTrivialLookup.probability,
    requestsDepth: answers.requestsDepth.probability,
    requestsBrevity: answers.requestsBrevity.probability,
  };

  const confidences = (Object.keys(dimensions) as (keyof typeof dimensions)[])
    .map((id) => readEvaluationConfidence(providerMetadata, id))
    .filter((value): value is number => value !== undefined);
  const confidence = confidences.length > 0 ? Math.min(...confidences) : undefined;

  return routeEffort(dimensions, overrides, confidence, input.efforts);
}

export type { EffortVerdict } from "./policy.ts";
export type { EffortState } from "./questions.ts";
