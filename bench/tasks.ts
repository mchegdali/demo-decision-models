import {
  experimental_evaluate as evaluate,
  type Experimental_EvaluationModel as EvaluationModel,
  type Experimental_EvaluationQuestion as EvaluationQuestion,
} from "ai";
import { readJsonl } from "./lib/jsonl.ts";
import type { Prediction } from "./lib/metrics.ts";

export type Lang = "en" | "fr" | "other";

/** One scored request. `predictions` holds one entry per scored field (most cases have one). */
export interface CaseOutcome {
  readonly predictions: Readonly<Record<string, Prediction>>;
}

export interface Case {
  readonly task: string;
  readonly id: string;
  readonly lang: Lang;
  run(model: EvaluationModel): Promise<CaseOutcome>;
}

export interface TaskInfo {
  readonly name: string;
  readonly kind: "app" | "public" | "latency";
  readonly description: string;
  /** Label sets per scored field; the first field is the task's headline metric. */
  readonly fields: Readonly<Record<string, readonly string[]>>;
}

/**
 * The classifier modules read the configured evaluator at import time, so they are loaded only
 * after run.ts has set EVALUATOR_* for the run (see `loadClassifiers`).
 */
type Classifiers = Awaited<ReturnType<typeof loadClassifiers>>;

export async function loadClassifiers() {
  const [language, fastTool, injection, effort] = await Promise.all([
    import("../features/agents/classifiers/language-detector/index.ts"),
    import("../features/agents/classifiers/fast-tool-detector/index.ts"),
    import("../features/agents/classifiers/prompt-injection-detector/index.ts"),
    import("../features/agents/classifiers/effort-evaluator/index.ts"),
  ]);
  return { language, fastTool, injection, effort };
}

// --- app tasks --------------------------------------------------------------------------------

interface FastPathRow {
  readonly id: string;
  readonly en: string;
  readonly fr: string;
  readonly route: string;
  readonly when?: string;
  readonly location?: { readonly en: string; readonly fr: string };
}
interface OtherLanguageRow {
  readonly id: string;
  readonly text: string;
}
interface InjectionRow {
  readonly id: string;
  readonly source: "user-message" | "retrieved-document" | "tool-output";
  readonly attack: boolean;
  readonly en: string;
  readonly fr: string;
}
interface EffortRow {
  readonly id: string;
  readonly en: string;
  readonly fr: string;
}

const LANGUAGES = ["fr", "en", "other"] as const;
const ROUTES = ["handle:greeting", "handle:time", "handle:weather", "defer"] as const;
const INJECTION_PURPOSE =
  "Answers customer support questions about a SaaS billing product, using help-center pages " +
  "and billing tool results.";
const EFFORT_PURPOSE =
  "Answers developer questions about software documentation by searching and reading the web.";
const EFFORT_TOOLS =
  "searchDocs: searches the public web for documentation pages. " +
  "fetchPage: fetches one documentation page as clean Markdown.";
/** The fallback ladder from lib/ai/effort.ts; fixed so runs don't depend on the models.dev catalog. */
const EFFORT_LADDER = ["low", "medium", "high"] as const;

function normalizePlace(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function appCases(classifiers: Classifiers): Case[] {
  const fastPath = readJsonl<FastPathRow>("datasets/app/fast-path.jsonl");
  const otherLanguage = readJsonl<OtherLanguageRow>("datasets/app/language-other.jsonl");
  const injection = readJsonl<InjectionRow>("datasets/app/injection.jsonl");
  const effort = readJsonl<EffortRow>("datasets/app/effort.jsonl");
  const cases: Case[] = [];

  const languageCase = (id: string, lang: Lang, text: string, gold: string): Case => ({
    task: "language",
    id,
    lang,
    async run(model) {
      const verdict = await classifiers.language.detectLanguage({ text }, model);
      return {
        predictions: {
          language: { gold, predicted: verdict.language, probabilities: verdict.probabilities },
        },
      };
    },
  });

  for (const row of fastPath) {
    for (const lang of ["en", "fr"] as const) {
      const prompt = row[lang];
      cases.push(languageCase(`${row.id}-${lang}`, lang, prompt, lang));
      cases.push({
        task: "fast-path",
        id: `${row.id}-${lang}`,
        lang,
        async run(model) {
          const verdict = await classifiers.fastTool.detectFastTool({ prompt }, model);
          const route = classifiers.fastTool.isHandled(verdict)
            ? `handle:${verdict.intent}`
            : "defer";
          const predictions: Record<string, Prediction> = {
            route: { gold: row.route, predicted: route },
          };
          // Place and day only matter where code would answer with them.
          if (row.route !== "defer" && row.location) {
            const gold = normalizePlace(row.location[lang]);
            predictions.location = {
              gold,
              predicted: normalizePlace(verdict.location) || "(none)",
            };
          }
          if (row.route === "handle:weather" && row.when) {
            predictions.when = { gold: row.when, predicted: verdict.when };
          }
          return { predictions };
        },
      });
    }
  }
  for (const row of otherLanguage) cases.push(languageCase(row.id, "other", row.text, "other"));

  for (const row of injection) {
    for (const lang of ["en", "fr"] as const) {
      cases.push({
        task: "injection",
        id: `${row.id}-${lang}`,
        lang,
        async run(model) {
          const verdict = await classifiers.injection.detectPromptInjection(
            { assistantPurpose: INJECTION_PURPOSE, inputSource: row.source, input: row[lang] },
            model,
          );
          // Calibration on the decision the policy makes: the strongest signal is P(attack).
          const attack = Math.max(...Object.values(verdict.signals));
          return {
            predictions: {
              attack: {
                gold: row.attack ? "attack" : "benign",
                predicted: verdict.action === "allow" ? "benign" : "attack",
                probabilities: { attack, benign: 1 - attack },
              },
            },
          };
        },
      });
    }
  }

  for (const row of effort) {
    for (const lang of ["en", "fr"] as const) {
      cases.push({
        task: "effort",
        id: `${row.id}-${lang}`,
        lang,
        async run(model) {
          const verdict = await classifiers.effort.evaluateEffort(
            {
              prompt: row[lang],
              assistantPurpose: EFFORT_PURPOSE,
              availableTools: EFFORT_TOOLS,
              efforts: EFFORT_LADDER,
            },
            model,
          );
          // No ground truth: the tier is kept so EN/FR agreement can be measured.
          return { predictions: { tier: { gold: row.id, predicted: verdict.tier } } };
        },
      });
    }
  }
  return cases;
}

// --- public tasks -----------------------------------------------------------------------------

interface PublicRow<State, Gold> {
  readonly id: string;
  readonly lang: "en" | "fr";
  readonly state: State;
  readonly gold: Gold;
}

const MASSIVE_CRITERIA = {
  alarm_set: "Set or create an alarm or wake-up call.",
  weather_query: "Ask about the weather, temperature or forecast.",
  play_music: "Play music, a song, an artist, an album or a playlist.",
  calendar_set: "Add an event, meeting or reminder to the calendar.",
  datetime_query: "Ask for the current time, date or day, possibly somewhere else.",
  email_sendemail: "Write, send or reply to an email.",
  takeaway_order: "Order food for takeaway or delivery.",
  iot_hue_lightoff: "Turn off or switch off the lights.",
  news_query: "Ask for news or headlines.",
  transport_ticket: "Book or buy a train, bus or other transport ticket.",
} as const;

const MASSIVE_QUESTIONS = {
  intent: {
    type: "choice",
    instructions: "What does the user ask the voice assistant to do in `state`?",
    criteria: MASSIVE_CRITERIA,
  },
} as const satisfies Record<string, EvaluationQuestion>;

const XNLI_QUESTIONS = {
  relation: {
    type: "choice",
    instructions: "Assuming `premise` is true, what is the status of `hypothesis`?",
    criteria: {
      entailment: "The hypothesis is definitely true given the premise.",
      neutral: "The hypothesis might be true or false; the premise does not settle it.",
      contradiction: "The hypothesis is definitely false given the premise.",
    },
  },
} as const satisfies Record<string, EvaluationQuestion>;

const PAWSX_QUESTIONS = {
  paraphrase: {
    type: "boolean",
    instructions: "Do `sentence1` and `sentence2` mean exactly the same thing?",
    criteria: {
      true: "They are paraphrases: same meaning, including who did what to whom.",
      false: "Their meaning differs, even if they share most of their words.",
    },
  },
} as const satisfies Record<string, EvaluationQuestion>;

const SENTIMENT_LEVELS = ["negative", "neutral", "positive"] as const;
const SENTIMENT_QUESTIONS = {
  sentiment: {
    type: "score",
    instructions: "What is the overall sentiment the author of the tweet in `state` expresses?",
    criteria: [
      "Negative: the author is unhappy, critical, angry or sad.",
      "Neutral: factual or mixed, with no clear positive or negative feeling.",
      "Positive: the author is happy, enthusiastic, grateful or approving.",
    ],
  },
} as const satisfies Record<string, EvaluationQuestion>;

function argmax(probabilities: Readonly<Record<string, number>>): string {
  return Object.entries(probabilities).reduce((best, entry) =>
    entry[1] > best[1] ? entry : best,
  )[0];
}

function publicCases(): Case[] {
  const cases: Case[] = [];

  for (const row of readJsonl<PublicRow<string, string>>("datasets/public/massive.jsonl")) {
    cases.push({
      task: "massive",
      id: row.id,
      lang: row.lang,
      async run(model) {
        const { answers } = await evaluate({
          model,
          state: row.state,
          questions: MASSIVE_QUESTIONS,
          maxRetries: 0,
        });
        const { choice, probabilities } = answers.intent;
        return { predictions: { intent: { gold: row.gold, predicted: choice, probabilities } } };
      },
    });
  }

  for (const row of readJsonl<PublicRow<{ premise: string; hypothesis: string }, string>>(
    "datasets/public/xnli.jsonl",
  )) {
    cases.push({
      task: "xnli",
      id: row.id,
      lang: row.lang,
      async run(model) {
        const { answers } = await evaluate({
          model,
          state: row.state,
          questions: XNLI_QUESTIONS,
          maxRetries: 0,
        });
        const { choice, probabilities } = answers.relation;
        return { predictions: { relation: { gold: row.gold, predicted: choice, probabilities } } };
      },
    });
  }

  for (const row of readJsonl<PublicRow<{ sentence1: string; sentence2: string }, boolean>>(
    "datasets/public/pawsx.jsonl",
  )) {
    cases.push({
      task: "pawsx",
      id: row.id,
      lang: row.lang,
      async run(model) {
        const { answers } = await evaluate({
          model,
          state: row.state,
          questions: PAWSX_QUESTIONS,
          maxRetries: 0,
        });
        const yes = answers.paraphrase.probability;
        return {
          predictions: {
            paraphrase: {
              gold: String(row.gold),
              predicted: String(yes >= 0.5),
              probabilities: { true: yes, false: 1 - yes },
            },
          },
        };
      },
    });
  }

  for (const row of readJsonl<PublicRow<string, number>>("datasets/public/sentiment.jsonl")) {
    cases.push({
      task: "sentiment",
      id: row.id,
      lang: row.lang,
      async run(model) {
        const { answers } = await evaluate({
          model,
          state: row.state,
          questions: SENTIMENT_QUESTIONS,
          maxRetries: 0,
        });
        const { score, probabilities } = answers.sentiment;
        // Score levels come back keyed "0".."2"; map them onto names so metrics share one label set.
        const named = Object.fromEntries(
          SENTIMENT_LEVELS.map((label, index) => [label, probabilities?.[String(index)] ?? 0]),
        );
        const predicted = probabilities ? argmax(named) : SENTIMENT_LEVELS[Math.round(score)]!;
        return {
          predictions: {
            sentiment: {
              gold: SENTIMENT_LEVELS[row.gold]!,
              predicted,
              probabilities: probabilities ? named : undefined,
              score,
            },
          },
        };
      },
    });
  }
  return cases;
}

export const TASKS: readonly TaskInfo[] = [
  {
    name: "language",
    kind: "app",
    description: "language-detector (routed verdict)",
    fields: { language: LANGUAGES },
  },
  {
    name: "fast-path",
    kind: "app",
    description: "fast-tool-detector route, plus place and day where code answers",
    fields: { route: ROUTES, location: [], when: ["now", "today", "tomorrow", "later", "earlier"] },
  },
  {
    name: "injection",
    kind: "app",
    description: "prompt-injection-detector, attack = review or block",
    fields: { attack: ["attack", "benign"] },
  },
  {
    name: "effort",
    kind: "latency",
    description: "effort-evaluator, 7 questions per request",
    fields: { tier: [] },
  },
  {
    name: "massive",
    kind: "public",
    description: "MASSIVE intents (10-way choice)",
    fields: { intent: Object.keys(MASSIVE_CRITERIA) },
  },
  {
    name: "xnli",
    kind: "public",
    description: "XNLI (3-way choice)",
    fields: { relation: ["entailment", "neutral", "contradiction"] },
  },
  {
    name: "pawsx",
    kind: "public",
    description: "PAWS-X paraphrase (boolean)",
    fields: { paraphrase: ["true", "false"] },
  },
  {
    name: "sentiment",
    kind: "public",
    description: "Tweet sentiment (3-level score)",
    fields: { sentiment: SENTIMENT_LEVELS },
  },
];

export function buildCases(classifiers: Classifiers): Case[] {
  return [...appCases(classifiers), ...publicCases()];
}

/** The questions-count probe: one fixed state, 1/2/4/7 of the effort questions. */
export async function scalingQuestions(): Promise<
  Record<number, Record<string, EvaluationQuestion>>
> {
  const { EFFORT_QUESTIONS } =
    await import("../features/agents/classifiers/effort-evaluator/questions.ts");
  const ids = Object.keys(EFFORT_QUESTIONS) as (keyof typeof EFFORT_QUESTIONS)[];
  const pick = (count: number) =>
    Object.fromEntries(ids.slice(0, count).map((id) => [id, EFFORT_QUESTIONS[id]]));
  return { 1: pick(1), 2: pick(2), 4: pick(4), 7: pick(7) };
}

/**
 * The state for repetition `rep` of the questions-count probe. Each repetition gets a different
 * prompt (the EN effort prompts, round-robin) so servers that reuse a cached prompt prefix
 * (Ollama, Kev) can't answer a repeat from cache; every question count sees the same prompts.
 */
export function scalingState(rep: number) {
  const prompts = readJsonl<EffortRow>("datasets/app/effort.jsonl").map((row) => row.en);
  return {
    assistantPurpose: EFFORT_PURPOSE,
    availableTools: EFFORT_TOOLS,
    prompt: prompts[rep % prompts.length]!,
    supportedEfforts: EFFORT_LADDER.join(", "),
  };
}
