export type DetectedLanguage = "fr" | "en" | "other";

/** Languages the assistant can actually write replies in. */
export type ReplyLanguage = "fr" | "en";

/**
 * Below this confidence an `fr`/`en` answer is demoted to `other`. A cookbook-style starting
 * point — re-tune against real traffic before relying on it.
 */
export const LANGUAGE_CONFIDENCE_THRESHOLD = 0.5;

export interface LanguageVerdict {
  /** The routed language, after the confidence demotion. */
  readonly language: DetectedLanguage;
  /** What the model picked before demotion. */
  readonly rawChoice: DetectedLanguage;
  /** Full distribution over the three options, or `undefined` if the provider omitted it. */
  readonly probabilities: Record<DetectedLanguage, number> | undefined;
  /** Concentration of the distribution, or `undefined` if unavailable. */
  readonly confidence: number | undefined;
}

/**
 * Routes the raw Choice answer to one language. A missing confidence is trusted as-is: only a
 * reported, low confidence demotes `fr`/`en` to `other`.
 */
export function routeLanguage(
  choice: DetectedLanguage,
  probabilities: Record<DetectedLanguage, number> | undefined,
  confidence: number | undefined,
): LanguageVerdict {
  const unsure = confidence !== undefined && confidence < LANGUAGE_CONFIDENCE_THRESHOLD;
  const language = choice !== "other" && unsure ? "other" : choice;
  return { language, rawChoice: choice, probabilities, confidence };
}

/**
 * The language to write a reply in: French only when the detector is confident it is French,
 * English for everything else — including `other`, so an unknown language never blocks a reply.
 */
export function replyLanguage(verdict: LanguageVerdict): ReplyLanguage {
  return verdict.language === "fr" ? "fr" : "en";
}
