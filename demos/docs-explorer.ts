import { formatDocsAnswer } from "../lib/cli/index.ts";

const QUESTIONS: readonly string[] = [
  "In Vercel AI SDK 7, how do I stop a ToolLoopAgent after a fixed number of steps?",
  "Does the FooBarBaz JS framework support quantum-entangled hot reload?",
] as const;

/** Runs the docs-explorer agent against a couple of sample questions. */
export async function runDocsExplorerDemo(): Promise<void> {
  console.log("\n=== docs-explorer ===");
  const { exploreDocs } = await import("../features/agents/docs-explorer/index.ts");

  for (const question of QUESTIONS) {
    console.log(`\n> ${question}`);
    const result = await exploreDocs(question);
    console.log(formatDocsAnswer(result));
  }
}

if (process.env.OPENAI_API_KEY) {
  await runDocsExplorerDemo();
} else {
  console.log(
    "Skipping docs-explorer demo: OPENAI_API_KEY is not set. " +
      "It also needs a running SearXNG instance — see `pnpm searxng:up`.",
  );
}
