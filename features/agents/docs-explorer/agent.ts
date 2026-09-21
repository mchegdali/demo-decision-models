import { Output, stepCountIs, ToolLoopAgent } from "ai";
import { z } from "zod";
import { languageModel } from "../../../lib/ai/language-model.ts";
import type { ReasoningEffort } from "../../../lib/ai/effort.ts";
import { DOCS_EXPLORER_INSTRUCTIONS } from "./prompt.ts";
import { docsExplorerTools } from "./tools.ts";
import { docsAnswerSchema } from "./output.ts";
import { DOCS_EXPLORER_EFFORTS } from "./effort.ts";

/** Per-call compute budget: how many tool-use steps, and how hard the model should think. */
export interface AgentBudget {
  readonly maxSteps: number;
  readonly reasoningEffort: ReasoningEffort;
}

/**
 * `DOCS_EXPLORER_EFFORTS` is derived at runtime (from the models.dev snapshot, narrowed by
 * this agent's allow-list), so it can't be a literal tuple `z.enum` requires. This validates
 * the same rungs without one, at the callOptionsSchema boundary — the one place a bad rung
 * can actually be caught, since the OpenAI provider accepts an unchecked `string` here.
 */
const reasoningEffortSchema = z.custom<ReasoningEffort>(
  (value) =>
    typeof value === "string" && (DOCS_EXPLORER_EFFORTS as readonly string[]).includes(value),
  { message: `reasoningEffort must be one of: ${DOCS_EXPLORER_EFFORTS.join(", ")}` },
);

const budgetSchema = z.object({
  maxSteps: z.number().int().min(1),
  reasoningEffort: reasoningEffortSchema,
});

/**
 * Used when a caller doesn't pass a `budget` (e.g. `demos/docs-explorer.ts`'s plain calls).
 * The effort rung is the ladder's middle rung rather than a hardcoded literal, so this stays
 * correct automatically if `DOCS_EXPLORER_ALLOWED_EFFORTS` ever changes.
 */
const DEFAULT_BUDGET: AgentBudget = {
  maxSteps: 6,
  reasoningEffort: DOCS_EXPLORER_EFFORTS[Math.floor((DOCS_EXPLORER_EFFORTS.length - 1) / 2)]!,
};

export const docsExplorerAgent = new ToolLoopAgent({
  model: languageModel,
  instructions: DOCS_EXPLORER_INSTRUCTIONS,
  tools: docsExplorerTools,
  output: Output.object({ schema: docsAnswerSchema }),
  callOptionsSchema: z.object({ budget: budgetSchema.optional() }),
  prepareCall: ({ options, ...rest }) => {
    const budget = options?.budget ?? DEFAULT_BUDGET;
    return {
      ...rest,
      stopWhen: stepCountIs(budget.maxSteps),
      providerOptions: { openai: { reasoningEffort: budget.reasoningEffort } },
    };
  },
});
