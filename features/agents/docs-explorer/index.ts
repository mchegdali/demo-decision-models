import { docsExplorerAgent, type AgentBudget } from "./agent.ts";
import type { DocsAnswer } from "./output.ts";

export interface ExploreDocsOptions {
  readonly abortSignal?: AbortSignal;
  /** Step count and reasoning effort for this call. Defaults to the agent's own default. */
  readonly budget?: AgentBudget;
}

export interface ExploreDocsResult {
  readonly answer: DocsAnswer;
  readonly steps: number;
  readonly usage: {
    readonly inputTokens: number | undefined;
    readonly outputTokens: number | undefined;
  };
}

/** Answers a question by searching and reading documentation on the web. */
export async function exploreDocs(
  question: string,
  options: ExploreDocsOptions = {},
): Promise<ExploreDocsResult> {
  const result = await docsExplorerAgent.generate({
    prompt: question,
    abortSignal: options.abortSignal,
    options: { budget: options.budget },
  });

  return {
    answer: result.output,
    steps: result.steps.length,
    usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
  };
}

export type { AgentBudget } from "./agent.ts";
export { DOCS_EXPLORER_EFFORTS } from "./effort.ts";
export type { DocsAnswer } from "./output.ts";
