import type { Experimental_EvaluationQuestion as EvaluationQuestion } from "ai";

/** The text whose language is being detected, evaluated as one shared state. */
export interface LanguageState {
  /** The user's message. */
  text: string;
  /** Index signature so this satisfies the evaluator's JSON-object state shape. */
  readonly [key: string]: string;
}

export const LANGUAGE_QUESTIONS = {
  language: {
    type: "choice",
    instructions:
      "Which language is `text` written in? Judge the words the user actually wrote, " +
      "not the topic, and ignore code, product names, and identifiers embedded in it.",
    criteria: {
      fr: "The message is written in French.",
      en: "The message is written in English.",
      other:
        "The message is in any other language, or is too short or too neutral to tell " +
        "(a bare name, number, symbol, or emoji).",
    },
  },
} as const satisfies Record<string, EvaluationQuestion>;

export type LanguageQuestionId = keyof typeof LANGUAGE_QUESTIONS;
