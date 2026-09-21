import type { Experimental_EvaluationQuestion as EvaluationQuestion } from "ai";

/** The user's message plus the place-like substrings code found in it. */
export interface FastToolState {
  /** The user's request. */
  prompt: string;
  /** Substrings of `prompt` that might name a place, in prompt order. May be empty. */
  placeCandidates: string[];
  readonly [key: string]: string | string[];
}

export const FAST_TOOL_QUESTIONS = {
  intent: {
    type: "choice",
    instructions: "What does `prompt` ask the assistant to do?",
    criteria: {
      greeting:
        "It is only a greeting or pleasantry (hello, hi, bonjour, salut, hey), with nothing " +
        "further to answer.",
      time: "It only asks what the current time or date is, possibly in a named place.",
      weather:
        "It only asks about the current weather, the temperature, or the forecast, possibly " +
        "for a named place and day.",
      other:
        "It is anything else: a question or task that needs knowledge, research, or " +
        "reasoning — even when it opens with a greeting.",
    },
  },
  extraRequest: {
    type: "boolean",
    instructions:
      "Beyond saying hello, or asking the current time or weather, does `prompt` ask for " +
      "anything else that would need research, tools, or an explanation?",
    criteria: {
      true: "It also asks for something more: a how-to, an explanation, a task, or a lookup.",
      false: "It asks for nothing beyond a greeting, the current time, or the weather.",
    },
  },
  weatherWhen: {
    type: "choice",
    instructions:
      "Assuming `prompt` asks about the weather: for which moment does it want the weather?",
    criteria: {
      now: "Right now, or no moment is given (the default for a plain weather question).",
      today: "Later today, this afternoon, or tonight — the forecast for the current day.",
      tomorrow: "Tomorrow.",
      later:
        "A day beyond tomorrow, or a longer period such as this weekend, next week, or a " +
        "specific future date.",
      earlier:
        "A moment in the past, such as yesterday, last night, last week, or a specific past " +
        "date.",
    },
  },
} as const satisfies Record<string, EvaluationQuestion>;

export type FastToolIntent = keyof (typeof FAST_TOOL_QUESTIONS)["intent"]["criteria"];
export type WeatherWhen = keyof (typeof FAST_TOOL_QUESTIONS)["weatherWhen"]["criteria"];

/** Answer keys of the dynamic `location` question that do not point at a candidate. */
export const LOCATION_UNSPECIFIED = "unspecified";
export const LOCATION_UNLISTED = "unlisted";

export interface LocationQuestion {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
}

/**
 * Builds the `location` Choice question for one prompt: one option per candidate
 * (`place1`…`placeN`, each pointing at `placeCandidates[i]` in the state) plus two that never
 * match a candidate. `unlisted` covers a place code failed to extract, since the model cannot
 * choose a value that was never offered. Always at least two options, even with no candidates.
 *
 * Returns the question and the map from an option key back to the candidate text.
 */
export function buildLocationQuestion(candidates: readonly string[]): {
  readonly question: LocationQuestion;
  readonly placeByKey: ReadonlyMap<string, string>;
} {
  const criteria: Record<string, string> = {};
  const placeByKey = new Map<string, string>();

  candidates.forEach((candidate, index) => {
    const key = `place${index + 1}`;
    criteria[key] = `The place it is about is \`placeCandidates[${index}]\`.`;
    placeByKey.set(key, candidate);
  });
  criteria[LOCATION_UNSPECIFIED] = "It names no place at all.";
  criteria[LOCATION_UNLISTED] =
    "It names a place, but that place is none of the `placeCandidates`.";

  return {
    question: {
      type: "choice",
      instructions:
        "Assuming `prompt` asks about the time or the weather: which place is it about? Pick " +
        "a candidate only if it really is a geographic place the request targets — not an " +
        "ordinary word, a sentence opener, or the name of something else.",
      criteria,
    },
    placeByKey,
  };
}
