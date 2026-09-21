import type { PromptInjectionSignalId } from "./questions.ts";

export type PromptInjectionAction = "allow" | "review" | "block";

/**
 * Thresholds on each boolean signal's probability. These are cookbook-derived
 * starting points (see TypeSafe's LLM guardrails cookbook) — re-tune them against
 * real traffic before relying on them; a typed, calibrated answer guarantees the
 * interface, not that these particular cutoffs are correct for your data.
 */
export const REVIEW_THRESHOLD = 0.35;
export const BLOCK_THRESHOLD = 0.7;

/** A severity at or above this promotes a `review` verdict to `block`. */
export const SEVERITY_BLOCK_THRESHOLD = 2.0;

const PRECEDENCE: readonly PromptInjectionAction[] = ["block", "review", "allow"];

export interface PromptInjectionVerdict {
  readonly action: PromptInjectionAction;
  readonly severity: number;
  readonly signals: Record<PromptInjectionSignalId, number>;
  readonly triggered: PromptInjectionSignalId[];
}

/** Routes raw signal probabilities and a severity score to one policy action. */
export function routePromptInjection(
  signals: Record<PromptInjectionSignalId, number>,
  severity: number,
): PromptInjectionVerdict {
  const triggered: PromptInjectionSignalId[] = [];
  const actions: PromptInjectionAction[] = [];

  for (const [id, probability] of Object.entries(signals) as [PromptInjectionSignalId, number][]) {
    if (probability >= BLOCK_THRESHOLD) {
      triggered.push(id);
      actions.push("block");
    } else if (probability >= REVIEW_THRESHOLD) {
      triggered.push(id);
      actions.push("review");
    }
  }

  const promoted =
    severity >= SEVERITY_BLOCK_THRESHOLD
      ? actions.map((action) => (action === "review" ? "block" : action))
      : actions;

  const action = PRECEDENCE.find((candidate) => promoted.includes(candidate)) ?? "allow";
  return { action, severity, signals, triggered };
}
