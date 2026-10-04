import { experimental_evaluate as evaluate, type Experimental_EvaluationModel } from "ai";
import { readEvaluationConfidence } from "../../../../lib/ai/confidence.ts";
import { evaluatorModel } from "../../../../lib/ai/evaluator-model.ts";
import { extractLocationCandidates } from "./candidates.ts";
import { routeFastTool, type FastToolVerdict } from "./policy.ts";
import { buildLocationQuestion, FAST_TOOL_QUESTIONS, type FastToolState } from "./questions.ts";

export interface DetectFastToolInput {
  /** The user's request. */
  readonly prompt: string;
}

/**
 * Decides whether `input.prompt` is a greeting, a time question, or a weather question that
 * code can answer without a language model. One batched TypeSafe `evaluate` request: the
 * intent, an extra-request guard, and — speculatively, whatever the intent turns out to be —
 * the weather day and the place, over the same state. `policy.ts` then routes to handle/defer.
 *
 * The place is *selected* from substrings that plain code extracted from the prompt, so a
 * chosen place is always a literal piece of what the user typed. `model` defaults to the
 * configured evaluator.
 */
export async function detectFastTool(
  input: DetectFastToolInput,
  model: Experimental_EvaluationModel = evaluatorModel,
): Promise<FastToolVerdict> {
  const candidates = extractLocationCandidates(input.prompt);
  const { question: location, placeByKey } = buildLocationQuestion(candidates);

  const state: FastToolState = { prompt: input.prompt, placeCandidates: candidates };
  const { answers, providerMetadata } = await evaluate({
    model,
    state,
    questions: { ...FAST_TOOL_QUESTIONS, location },
  });

  const { intent, weatherWhen, extraRequest } = answers;
  return routeFastTool({
    intent: intent.choice,
    intentProbability: intent.probabilities?.[intent.choice],
    intentConfidence: readEvaluationConfidence(providerMetadata, "intent"),
    extraRequest: extraRequest.probability,
    when: weatherWhen.choice,
    place: placeByKey.get(answers.location.choice),
    placeProbability: answers.location.probabilities?.[answers.location.choice],
  });
}

export { isHandled } from "./policy.ts";
export type {
  DeferReason,
  FastToolAction,
  FastToolVerdict,
  HandledIntent,
  HandledVerdict,
} from "./policy.ts";
export type { FastToolIntent, FastToolState, WeatherWhen } from "./questions.ts";
