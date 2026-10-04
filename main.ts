import { parseArgs } from "node:util";
import type { EffortVerdict } from "./features/agents/classifiers/effort-evaluator/index.ts";
import type { FastToolVerdict } from "./features/agents/classifiers/fast-tool-detector/index.ts";
import type { LanguageVerdict } from "./features/agents/classifiers/language-detector/index.ts";
import type { PromptInjectionVerdict } from "./features/agents/classifiers/prompt-injection-detector/index.ts";
import type { DocsAnswer } from "./features/agents/docs-explorer/index.ts";
import {
  formatDocsAnswer,
  formatEffortVerdict,
  formatFastToolVerdict,
  formatInjectionVerdict,
  formatLanguageVerdict,
} from "./lib/cli/index.ts";
import { evaluatorEnv } from "./lib/env.ts";

const USAGE = `Usage: pnpm dev [--json] <question>
       pnpm dev --help

Screens a question for prompt injection and detects its language. A greeting, the time,
or the weather is answered by code alone, with no language model. Anything else has its
effort judged, then is answered by searching and reading documentation on the web.

Options:
  --json       Print a single JSON result to stdout instead of human-readable text.
  -h, --help   Show this help and exit.`;

/** What this program is: passed to both classifiers as context. */
const ASSISTANT_PURPOSE =
  "Answers developer questions about software documentation by searching and reading the web.";

/** The docs-explorer agent's tools, briefly described for the effort classifier. */
const AVAILABLE_TOOLS =
  "searchDocs: searches the public web for documentation pages. " +
  "fetchPage: fetches one documentation page as clean Markdown.";

interface Cli {
  readonly json: boolean;
  readonly question: string;
}

const CLI_OPTIONS = {
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} as const;

/** Parses and validates argv, or throws a message meant for stderr. */
function parseCli(argv: readonly string[]): Cli {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof CLI_OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, options: CLI_OPTIONS, allowPositionals: true });
  } catch (error) {
    throw new Error(`${(error as Error).message}\n\n${USAGE}`);
  }

  if (parsed.values.help) {
    console.log(USAGE);
    process.exit(0);
  }

  if (parsed.positionals.length !== 1) {
    throw new Error(`Expected exactly one question argument.\n\n${USAGE}`);
  }

  const question = parsed.positionals[0]!.trim();
  if (!question) {
    throw new Error(`Question must not be empty.\n\n${USAGE}`);
  }

  return { json: parsed.values.json ?? false, question };
}

/** Fails fast, listing every missing API key of `names` at once. */
function checkRequiredEnv(names: readonly string[]): void {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}.`);
  }
}

/** Everything one run learned, for `--json`. Fields a run never reached are `null`. */
interface Report {
  readonly question: string;
  readonly screening: PromptInjectionVerdict;
  readonly language: LanguageVerdict;
  readonly fastTool: FastToolVerdict;
  readonly effort: EffortVerdict | null;
  /** The code-only reply, when the fast path answered. */
  readonly fastAnswer: string | null;
  /** The docs-explorer answer, when the full pipeline ran. */
  readonly answer: DocsAnswer | null;
}

function printJson(report: Report): void {
  console.log(JSON.stringify(report, null, 2));
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  checkRequiredEnv(evaluatorEnv());

  const [
    { detectPromptInjection },
    { detectLanguage, replyLanguage },
    { detectFastTool, isHandled },
  ] = await Promise.all([
    import("./features/agents/classifiers/prompt-injection-detector/index.ts"),
    import("./features/agents/classifiers/language-detector/index.ts"),
    import("./features/agents/classifiers/fast-tool-detector/index.ts"),
  ]);

  // Round 1 — TypeSafe only. The three classifiers judge the same raw question over
  // independent state, so they share one parallel round trip. None of them needs OpenAI.
  const [injection, language, fastTool] = await Promise.all([
    detectPromptInjection({
      assistantPurpose: ASSISTANT_PURPOSE,
      inputSource: "user-message",
      input: cli.question,
    }),
    detectLanguage({ text: cli.question }),
    detectFastTool({ prompt: cli.question }),
  ]);

  const report: Report = {
    question: cli.question,
    screening: injection,
    language,
    fastTool,
    effort: null,
    fastAnswer: null,
    answer: null,
  };

  if (injection.action === "block") {
    if (cli.json) {
      printJson(report);
    } else {
      console.error(`Refusing to answer: this input looks like a prompt injection attempt.`);
      console.error(formatInjectionVerdict(injection));
    }
    process.exitCode = 1;
    return;
  }

  if (!cli.json) {
    if (injection.action === "review") {
      console.error("Warning: this input was flagged for review before answering.");
      console.error(formatInjectionVerdict(injection));
    }
    console.error(formatLanguageVerdict(language));
    console.error(formatFastToolVerdict(fastTool));
  }

  // Fast path: a greeting, the time, or the weather is composed in code. The effort evaluator
  // and docs-explorer are never imported, so the OpenAI provider is never constructed and
  // OPENAI_API_KEY is not needed.
  if (isHandled(fastTool)) {
    const { answerFast } = await import("./features/fast-answers/index.ts");
    const fastAnswer = await answerFast(fastTool, replyLanguage(language));

    if (cli.json) {
      printJson({ ...report, fastAnswer });
    } else {
      console.log(fastAnswer);
    }
    return;
  }

  // Round 2 — the full pipeline. The effort call now waits for round 1 instead of racing it:
  // one extra cheap round trip here is what lets a fast-path prompt skip it entirely.
  checkRequiredEnv(["OPENAI_API_KEY"]);
  const [{ evaluateEffort }, { exploreDocs, DOCS_EXPLORER_EFFORTS }] = await Promise.all([
    import("./features/agents/classifiers/effort-evaluator/index.ts"),
    import("./features/agents/docs-explorer/index.ts"),
  ]);

  const effort = await evaluateEffort({
    prompt: cli.question,
    assistantPurpose: ASSISTANT_PURPOSE,
    availableTools: AVAILABLE_TOOLS,
    efforts: DOCS_EXPLORER_EFFORTS,
  });

  if (!cli.json) {
    console.error(formatEffortVerdict(effort));
  }

  const result = await exploreDocs(cli.question, {
    budget: { maxSteps: effort.maxSteps, reasoningEffort: effort.tier },
  });

  if (cli.json) {
    printJson({ ...report, effort, answer: result.answer });
  } else {
    console.log(formatDocsAnswer(result));
  }
}

try {
  await main();
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
