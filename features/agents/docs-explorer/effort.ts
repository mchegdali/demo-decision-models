import {
  LANGUAGE_MODEL_EFFORTS,
  resolveEffortLadder,
  type ReasoningEffort,
} from "../../../lib/ai/effort.ts";

/**
 * Effort rungs this agent may be budgeted at. `"none"` is excluded: docs-explorer is a
 * tool-loop agent, and with reasoning fully off the model tends to fail at planning even
 * a single search call. `"max"` is excluded as disproportionate for documentation lookup.
 * Both are one-line changes if that judgment turns out wrong for this agent.
 */
export const DOCS_EXPLORER_ALLOWED_EFFORTS: readonly ReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
];

/** `DOCS_EXPLORER_ALLOWED_EFFORTS` narrowed to what `LANGUAGE_MODEL_ID` actually supports. */
export const DOCS_EXPLORER_EFFORTS = resolveEffortLadder(
  LANGUAGE_MODEL_EFFORTS,
  DOCS_EXPLORER_ALLOWED_EFFORTS,
);
