import type { ReasoningEffort } from "../../../../lib/ai/effort.ts";
import type { EffortDimensionId, EffortQuestionId } from "./questions.ts";

/**
 * Weights for the weighted-mean composite over the four Score dimensions. Sum to 1 so
 * the composite lands directly on the 0..`MAX_EFFORT` scale. Cookbook-derived starting
 * points — re-tune against real traffic before relying on them.
 */
export const DIMENSION_WEIGHTS: Record<EffortDimensionId, number> = {
  taskComplexity: 0.35,
  researchBreadth: 0.3,
  stakes: 0.2,
  ambiguity: 0.15,
};

/** Top of the composite scale: one less than the four dimensions' shared level count (4). */
export const MAX_EFFORT = 3;

/**
 * Override thresholds and their effect on the composite, applied in this order:
 * trivial-lookup caps first, then depth floors, then brevity caps last so an explicit
 * "keep it short" instruction always wins over an inferred depth signal.
 */
export const TRIVIAL_LOOKUP_PROBABILITY_THRESHOLD = 0.7;
/**
 * Deliberately not `0.5`: quantization rounds an exact tie up (`Math.round(0.5) === 1`),
 * and `0.5` sits exactly on the bottom-rung boundary for a 4-rung ladder — that value
 * would round a trivial lookup up to the second rung instead of the bottom one. `0.2`
 * stays under the bottom-rung boundary (`1.5 / (ladder.length - 1)`) for every ladder up
 * to the full 7-rung `none..max` list, so this reliably forces the cheapest rung.
 */
export const TRIVIAL_LOOKUP_EFFORT_CAP = 0.2;
export const REQUESTS_DEPTH_PROBABILITY_THRESHOLD = 0.6;
export const REQUESTS_DEPTH_EFFORT_FLOOR = 1.6;
export const REQUESTS_BREVITY_PROBABILITY_THRESHOLD = 0.6;
export const REQUESTS_BREVITY_EFFORT_CAP = 1.2;

/**
 * Step budget interpolated linearly over the normalized composite, across any ladder
 * length. `MIN_STEPS = 3` is not arbitrary: docs-explorer's own instructions forbid
 * answering from memory, so search -> fetch -> finalize is the practical floor for any
 * question through that agent — `1` or `2` reliably cut the loop off mid-tool-call and
 * surface as a `NoOutputGeneratedError` ("No output generated"), confirmed live.
 */
export const MIN_STEPS = 3;
export const MAX_STEPS = 12;

/**
 * Below this, the weakest (minimum) confidence across the four Score answers is treated
 * as "the model isn't sure how much this task needs" and the verdict is bumped one rung
 * up the ladder rather than left as-is — for an effort budget, uncertainty should resolve
 * toward overspending, not toward starving the agent. The one exception is an explicit cap
 * (a trivial lookup, or a request for brevity) that decided the final composite: doubt about
 * how hard the task is must not override a direct "this needs little" signal.
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.4;

export interface EffortVerdict {
  /** The chosen rung — always a member of the `ladder` passed to `routeEffort`. */
  readonly tier: ReasoningEffort;
  /** The raw weighted-and-overridden composite, before quantization, in 0..`MAX_EFFORT`. */
  readonly effort: number;
  readonly maxSteps: number;
  /** Every raw judgment, for re-weighting or debugging without re-running inference. */
  readonly signals: Record<EffortQuestionId, number>;
  /** The weakest confidence across the four Score answers, or `undefined` if unavailable. */
  readonly confidence: number | undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Routes four Score dimensions and three Boolean overrides to one `EffortVerdict`,
 * quantized onto `ladder`. `ladder` is a parameter rather than an import so this stays
 * testable against a synthetic ladder of any length, independent of model config.
 */
export function routeEffort(
  dimensions: Record<EffortDimensionId, number>,
  overrides: Record<Exclude<EffortQuestionId, EffortDimensionId>, number>,
  confidence: number | undefined,
  ladder: readonly ReasoningEffort[],
): EffortVerdict {
  if (ladder.length === 0) {
    throw new Error("routeEffort: ladder must contain at least one effort rung.");
  }

  let effort =
    dimensions.taskComplexity * DIMENSION_WEIGHTS.taskComplexity +
    dimensions.researchBreadth * DIMENSION_WEIGHTS.researchBreadth +
    dimensions.stakes * DIMENSION_WEIGHTS.stakes +
    dimensions.ambiguity * DIMENSION_WEIGHTS.ambiguity;

  // Whether the composite's final value came from an explicit "keep it cheap" cap. Tracked in
  // the same order as the overrides: a depth floor outranks an inferred trivial-lookup cap, and
  // a brevity cap outranks everything.
  let capped = false;
  if (overrides.isTrivialLookup >= TRIVIAL_LOOKUP_PROBABILITY_THRESHOLD) {
    effort = Math.min(effort, TRIVIAL_LOOKUP_EFFORT_CAP);
    capped = true;
  }
  if (overrides.requestsDepth >= REQUESTS_DEPTH_PROBABILITY_THRESHOLD) {
    effort = Math.max(effort, REQUESTS_DEPTH_EFFORT_FLOOR);
    capped = false;
  }
  if (overrides.requestsBrevity >= REQUESTS_BREVITY_PROBABILITY_THRESHOLD) {
    effort = Math.min(effort, REQUESTS_BREVITY_EFFORT_CAP);
    capped = true;
  }

  const normalized = clamp(effort / MAX_EFFORT, 0, 1);
  let index = clamp(Math.round(normalized * (ladder.length - 1)), 0, ladder.length - 1);

  if (!capped && confidence !== undefined && confidence < LOW_CONFIDENCE_THRESHOLD) {
    index = clamp(index + 1, 0, ladder.length - 1);
  }

  // `index` is always clamped into `[0, ladder.length - 1]` and `ladder.length > 0` is
  // checked above, so this lookup cannot miss.
  const tier = ladder[index]!;
  const maxSteps = clamp(
    Math.round(MIN_STEPS + normalized * (MAX_STEPS - MIN_STEPS)),
    MIN_STEPS,
    MAX_STEPS,
  );

  return {
    tier,
    effort,
    maxSteps,
    signals: { ...dimensions, ...overrides },
    confidence,
  };
}
