import { parseArgs } from "node:util";
import { formatDocsAnswer, formatEffortVerdict, formatInjectionVerdict } from "./lib/cli/index.ts";

const USAGE = `Usage: pnpm dev [--json] <question>
       pnpm dev --help

Screens a question for prompt injection, judges how much effort it deserves, then
answers it by searching and reading documentation on the web.

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

/** Fails fast, listing every missing required API key at once. */
function checkRequiredEnv(): void {
  const missing = ["TYPESAFE_AI_API_KEY", "OPENAI_API_KEY"].filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}.`);
  }
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  checkRequiredEnv();

  const [{ detectPromptInjection }, { evaluateEffort }, { exploreDocs, DOCS_EXPLORER_EFFORTS }] =
    await Promise.all([
      import("./features/agents/classifiers/prompt-injection-detector/index.ts"),
      import("./features/agents/classifiers/effort-evaluator/index.ts"),
      import("./features/agents/docs-explorer/index.ts"),
    ]);

  // Both classifiers judge the same raw question, over independent state, so they run in
  // one parallel round trip. The effort call is wasted when the input is later blocked, but
  // that one cheap request is cheaper than serializing the two calls for every allowed input.
  const [injection, effort] = await Promise.all([
    detectPromptInjection({
      assistantPurpose: ASSISTANT_PURPOSE,
      inputSource: "user-message",
      input: cli.question,
    }),
    evaluateEffort({
      prompt: cli.question,
      assistantPurpose: ASSISTANT_PURPOSE,
      availableTools: AVAILABLE_TOOLS,
      efforts: DOCS_EXPLORER_EFFORTS,
    }),
  ]);

  if (injection.action === "block") {
    if (cli.json) {
      console.log(
        JSON.stringify(
          { question: cli.question, screening: injection, effort, answer: null },
          null,
          2,
        ),
      );
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
    console.error(formatEffortVerdict(effort));
  }

  const result = await exploreDocs(cli.question, {
    budget: { maxSteps: effort.maxSteps, reasoningEffort: effort.tier },
  });

  if (cli.json) {
    console.log(
      JSON.stringify(
        { question: cli.question, screening: injection, effort, answer: result.answer },
        null,
        2,
      ),
    );
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
