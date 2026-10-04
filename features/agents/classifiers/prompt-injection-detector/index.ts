import { experimental_evaluate as evaluate, type Experimental_EvaluationModel } from "ai";
import { evaluatorModel } from "../../../../lib/ai/evaluator-model.ts";
import { routePromptInjection, type PromptInjectionVerdict } from "./policy.ts";
import { PROMPT_INJECTION_QUESTIONS, type PromptInjectionState } from "./questions.ts";

/**
 * Screens untrusted text for prompt-injection attempts using one batched TypeSafe
 * `evaluate` request: several independent boolean judgments plus a severity score
 * over the same shared state, routed to allow/review/block by `policy.ts`. `model` defaults to
 * the configured evaluator.
 */
export async function detectPromptInjection(
  state: PromptInjectionState,
  model: Experimental_EvaluationModel = evaluatorModel,
): Promise<PromptInjectionVerdict> {
  const { answers } = await evaluate({
    model,
    state,
    questions: PROMPT_INJECTION_QUESTIONS,
  });

  const signals = {
    instructionOverride: answers.instructionOverride.probability,
    personaHijack: answers.personaHijack.probability,
    embeddedDirective: answers.embeddedDirective.probability,
    dataExfiltration: answers.dataExfiltration.probability,
  };

  return routePromptInjection(signals, answers.severity.score);
}

export type { PromptInjectionAction, PromptInjectionVerdict } from "./policy.ts";
export type { PromptInjectionState } from "./questions.ts";
