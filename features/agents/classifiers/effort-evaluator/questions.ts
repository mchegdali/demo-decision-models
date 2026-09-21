import type { Experimental_EvaluationQuestion as EvaluationQuestion } from "ai";

/** A user prompt plus the context needed to judge how much effort it deserves. */
export interface EffortState {
  /** What the assistant answering `prompt` is for, in a sentence or two. */
  assistantPurpose: string;
  /** The tools available to the assistant, briefly described. */
  availableTools: string;
  /** The user's request. */
  prompt: string;
  /**
   * The effort rungs available for this answer, comma-separated from cheapest to most
   * expensive (e.g. "low, medium, high"). Order matters and is not implied by the list.
   */
  supportedEfforts: string;
  /** Index signature so this satisfies the evaluator's JSON-object state shape. */
  readonly [key: string]: string;
}

export const EFFORT_QUESTIONS = {
  taskComplexity: {
    type: "score",
    instructions:
      "How many distinct sub-tasks or reasoning steps does answering `prompt` decompose into?",
    criteria: [
      "One direct step: a single fact or action with no sub-parts to combine.",
      "A couple of related steps that must be done in sequence, e.g. look up a value then use it.",
      "Several sub-tasks whose results must be combined or compared with each other.",
      "Many interdependent sub-tasks, or sub-tasks that branch depending on earlier findings.",
    ],
  },
  ambiguity: {
    type: "score",
    instructions:
      "How underspecified is `prompt` — how much must be inferred, assumed, or clarified " +
      "before it can be answered well?",
    criteria: [
      "Fully specified: every detail needed to answer is already stated.",
      "Minor gaps that any reasonable default resolves without changing the answer.",
      "Missing a detail that meaningfully changes what a good answer looks like.",
      "So open-ended that different reasonable readings would produce different answers.",
    ],
  },
  researchBreadth: {
    type: "score",
    instructions:
      "Given `availableTools`, how many distinct external sources would answering `prompt` " +
      "well require consulting?",
    criteria: [
      "None: answerable from general knowledge, with no tool use.",
      "One source: a single lookup or page covers it.",
      "A handful of sources that must be found and read separately.",
      "Many sources across different sites or documents, needing synthesis across all of them.",
    ],
  },
  stakes: {
    type: "score",
    instructions:
      "Given `assistantPurpose`, how costly would a shallow or subtly wrong answer to " +
      "`prompt` be?",
    criteria: [
      "Negligible: a wrong answer is trivially noticed and cheaply corrected.",
      "Minor inconvenience: the user re-asks or double-checks, no real harm done.",
      "Meaningful cost: the user could act on a wrong answer before noticing the mistake.",
      "Severe: a wrong or shallow answer could cause real damage or be hard to detect at all.",
    ],
  },
  isTrivialLookup: {
    type: "boolean",
    instructions:
      "Is `prompt` a single well-known fact, answerable directly with no tool use at all?",
    criteria: {
      true: "A single well-known fact or definition; no lookup or reasoning is needed.",
      false: "Answering well needs at least one lookup, calculation, or reasoning step.",
    },
  },
  requestsDepth: {
    type: "boolean",
    instructions:
      "Does `prompt` explicitly ask for thorough, exhaustive, or detailed work (e.g. " +
      '"in depth", "comprehensive", "don\'t miss anything")?',
    criteria: {
      true: "It explicitly asks for thoroughness, comprehensiveness, or exhaustive detail.",
      false: "It does not explicitly ask for unusual thoroughness or detail.",
    },
  },
  requestsBrevity: {
    type: "boolean",
    instructions:
      "Does `prompt` explicitly ask for a quick, short, or minimal-effort response (e.g. " +
      '"quick answer", "just the gist", "one line")?',
    criteria: {
      true: "It explicitly asks for brevity, speed, or a minimal-effort response.",
      false: "It does not explicitly ask for brevity or speed.",
    },
  },
} as const satisfies Record<string, EvaluationQuestion>;

export type EffortQuestionId = keyof typeof EFFORT_QUESTIONS;

/** The four Score questions that feed the weighted composite. */
export type EffortDimensionId = Extract<
  EffortQuestionId,
  "taskComplexity" | "ambiguity" | "researchBreadth" | "stakes"
>;

/** The three boolean questions that override the composite. */
export type EffortOverrideId = Exclude<EffortQuestionId, EffortDimensionId>;
