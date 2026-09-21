import type { FastToolIntent, WeatherWhen } from "./questions.ts";

export type FastToolAction = "handle" | "defer";

/** The intents code can answer without a language model. */
export type HandledIntent = Exclude<FastToolIntent, "other">;

/**
 * Thresholds on the raw judgments. Starting points, not tuned values — re-tune them against
 * real traffic, since a typed answer guarantees the interface, not that these cutoffs fit.
 * Deferring is the safe direction: it just sends the prompt down the full pipeline.
 */
export const INTENT_PROBABILITY_THRESHOLD = 0.7;
export const INTENT_CONFIDENCE_THRESHOLD = 0.6;
/** At or above this, the prompt asks for more than a fast answer can give. */
export const EXTRA_REQUEST_THRESHOLD = 0.4;
/** A place is only used when its option is at least this likely; else it is "not stated". */
export const LOCATION_PROBABILITY_THRESHOLD = 0.6;

export type DeferReason =
  | "not-a-fast-intent"
  | "unknown-probability"
  | "low-intent-probability"
  | "low-intent-confidence"
  | "extra-request"
  | "unsupported-day";

/** Everything `routeFastTool` needs, already unpacked from the model's answers. */
export interface FastToolJudgments {
  readonly intent: FastToolIntent;
  /** Probability of `intent`, or `undefined` if the provider omitted the distribution. */
  readonly intentProbability: number | undefined;
  /** Concentration of the intent distribution, or `undefined` if unavailable. */
  readonly intentConfidence: number | undefined;
  readonly extraRequest: number;
  readonly when: WeatherWhen;
  /** The candidate text the model picked, or `undefined` for "none / unlisted". */
  readonly place: string | undefined;
  /** Probability of the picked location option, or `undefined` if unavailable. */
  readonly placeProbability: number | undefined;
}

export interface FastToolVerdict {
  readonly action: FastToolAction;
  /** The model's pick, kept even when deferring so the decision can be debugged. */
  readonly intent: FastToolIntent;
  readonly when: WeatherWhen;
  /** The place to use, or `undefined` when none was stated or the model wasn't sure. */
  readonly location: string | undefined;
  readonly reason: DeferReason | "handled";
  readonly confidence: number | undefined;
  /** Every raw probability, for re-thresholding without re-running inference. */
  readonly signals: {
    readonly intent: number | undefined;
    readonly extraRequest: number;
    readonly location: number | undefined;
  };
}

/** A verdict code can answer itself; `intent` is narrowed so callers never see `"other"`. */
export type HandledVerdict = FastToolVerdict & {
  readonly action: "handle";
  readonly intent: HandledIntent;
};

export function isHandled(verdict: FastToolVerdict): verdict is HandledVerdict {
  return verdict.action === "handle" && verdict.intent !== "other";
}

/**
 * Decides whether code alone can answer. Requires a fast intent the model is both likely and
 * confident about, and no additional request hiding behind it ("bonjour, comment marche X ?").
 * Weather for a day the forecast doesn't cover is deferred rather than answered wrongly.
 */
export function routeFastTool(judgments: FastToolJudgments): FastToolVerdict {
  const { intent, intentProbability, intentConfidence, extraRequest, when, place } = judgments;

  const location =
    place !== undefined &&
    judgments.placeProbability !== undefined &&
    judgments.placeProbability >= LOCATION_PROBABILITY_THRESHOLD
      ? place
      : undefined;

  const reason = deferReason(judgments);
  return {
    action: reason === "handled" ? "handle" : "defer",
    intent,
    when,
    location,
    reason,
    confidence: intentConfidence,
    signals: {
      intent: intentProbability,
      extraRequest,
      location: judgments.placeProbability,
    },
  };
}

function deferReason(judgments: FastToolJudgments): DeferReason | "handled" {
  if (judgments.intent === "other") return "not-a-fast-intent";

  const { intentProbability, intentConfidence } = judgments;
  if (intentProbability === undefined && intentConfidence === undefined) {
    return "unknown-probability";
  }
  if (intentProbability !== undefined && intentProbability < INTENT_PROBABILITY_THRESHOLD) {
    return "low-intent-probability";
  }
  if (intentConfidence !== undefined && intentConfidence < INTENT_CONFIDENCE_THRESHOLD) {
    return "low-intent-confidence";
  }
  if (judgments.extraRequest >= EXTRA_REQUEST_THRESHOLD) return "extra-request";
  // The fast answer covers now, today and tomorrow only; past and far-future days defer.
  if (
    judgments.intent === "weather" &&
    (judgments.when === "later" || judgments.when === "earlier")
  ) {
    return "unsupported-day";
  }
  return "handled";
}
