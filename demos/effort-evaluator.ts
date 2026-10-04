import { formatEffortVerdict } from "../lib/cli/index.ts";
import { evaluatorEnv } from "../lib/env.ts";

/** Mirrors `main.ts`'s constants — kept local so this demo has no dependency on the CLI. */
const ASSISTANT_PURPOSE =
  "Answers developer questions about software documentation by searching and reading the web.";
const AVAILABLE_TOOLS =
  "searchDocs: searches the public web for documentation pages. " +
  "fetchPage: fetches one documentation page as clean Markdown.";

/** Spans the ladder end to end: trivial, brevity-capped, ordinary, depth-floored, broad. */
const EFFORT_SAMPLES: readonly string[] = [
  "What's the default port for Vite?",
  "Quick — one line: how do I pin a pnpm version with corepack?",
  "How do I add a custom HTTP header to every fetch request in the Vercel AI SDK?",
  "Do a thorough, in-depth comparison of retry and backoff behavior across the OpenAI " +
    "and Anthropic AI SDK providers, citing the exact defaults for each.",
  "I'm evaluating whether to migrate our internal tools from LangChain to the Vercel AI " +
    "SDK — compare their agent loop, tool-calling, and streaming APIs across current " +
    "versions, and flag any breaking changes we'd hit.",
] as const;

/** Runs the effort-evaluator classifier against a handful of sample prompts. */
export async function runEffortEvaluatorDemo(): Promise<void> {
  console.log("\n=== effort-evaluator ===");
  const { evaluateEffort } =
    await import("../features/agents/classifiers/effort-evaluator/index.ts");
  const { DOCS_EXPLORER_EFFORTS } = await import("../features/agents/docs-explorer/index.ts");

  console.log(`ladder: [${DOCS_EXPLORER_EFFORTS.join(", ")}]`);

  for (const prompt of EFFORT_SAMPLES) {
    const verdict = await evaluateEffort({
      prompt,
      assistantPurpose: ASSISTANT_PURPOSE,
      availableTools: AVAILABLE_TOOLS,
      efforts: DOCS_EXPLORER_EFFORTS,
    });
    console.log(`\n> ${JSON.stringify(prompt.slice(0, 80))}...`);
    console.log(formatEffortVerdict(verdict));
  }
}

// The docs-explorer import above constructs the OpenAI provider eagerly, so OPENAI_API_KEY is
// required even though this demo never calls the language model itself.
const missing = [...evaluatorEnv(), "OPENAI_API_KEY"].filter((name) => !process.env[name]);
if (missing.length === 0) {
  await runEffortEvaluatorDemo();
} else {
  console.log(`Skipping effort-evaluator demo: ${missing.join(" and ")} must be set.`);
}
