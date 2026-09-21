import { providers } from "@opencode-ai/models/snapshot";
import type { ReasoningOption, ReasoningOptionEffort } from "@opencode-ai/models";
import { LANGUAGE_MODEL_ID } from "./language-model.ts";

/** Reasoning effort levels the OpenAI provider accepts. Mirrors `@ai-sdk/openai`'s union. */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const REASONING_EFFORT_VALUES: readonly ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Narrows an `@opencode-ai/models` effort value, dropping its `null`/`"default"` cases. */
function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    typeof value === "string" && (REASONING_EFFORT_VALUES as readonly string[]).includes(value)
  );
}

function isEffortOption(option: ReasoningOption): option is ReasoningOptionEffort {
  return option.type === "effort";
}

/**
 * Rungs used when the bundled models.dev snapshot doesn't know `LANGUAGE_MODEL_ID` (e.g. a
 * brand-new model release lagging the catalog). Conservative: the three rungs nearly every
 * current OpenAI reasoning model accepts.
 */
const FALLBACK_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high"];

/** Looks up `LANGUAGE_MODEL_ID`'s supported effort rungs in the bundled models.dev snapshot. */
function lookupSupportedEfforts(): readonly ReasoningEffort[] | undefined {
  const model = providers.openai?.models[LANGUAGE_MODEL_ID];
  const effortOption = model?.reasoning_options?.find(isEffortOption);
  if (!effortOption) return undefined;

  const values = effortOption.values.filter(isReasoningEffort);
  return values.length > 0 ? values : undefined;
}

/**
 * Rungs `LANGUAGE_MODEL_ID` supports, cheapest -> most expensive, from the bundled
 * models.dev catalog (`@opencode-ai/models/snapshot`, no runtime network). Derived rather
 * than hand-written: `@ai-sdk/openai` exposes one flat `reasoningEffort` union for every
 * model, and on the Responses API path that option is typed as a bare `string`, so a wrong
 * rung is not caught at compile time — it only shows up later as a runtime provider warning.
 */
export const LANGUAGE_MODEL_EFFORTS: readonly ReasoningEffort[] = (() => {
  const supported = lookupSupportedEfforts();
  if (supported) return supported;
  console.warn(
    `lib/ai/effort: models.dev snapshot has no reasoning-effort data for "${LANGUAGE_MODEL_ID}"; ` +
      `falling back to ${JSON.stringify(FALLBACK_EFFORTS)}. Check @opencode-ai/models is current.`,
  );
  return FALLBACK_EFFORTS;
})();

/**
 * Intersects a model's supported rungs with an agent's allow-list, preserving the model's
 * cheap -> expensive ordering — never the allow-list's, since that is a set, not a sequence,
 * and taking order from it would silently corrupt any code that quantizes onto the result.
 * Rungs the model doesn't support are dropped silently; an empty result means the allow-list
 * shares no rung with the model at all, which is a misconfiguration and fails fast, matching
 * `requireEnv`'s style.
 */
export function resolveEffortLadder(
  supported: readonly ReasoningEffort[],
  allowed?: readonly ReasoningEffort[],
): readonly ReasoningEffort[] {
  const ladder = allowed ? supported.filter((effort) => allowed.includes(effort)) : supported;
  if (ladder.length === 0) {
    throw new Error(
      `resolveEffortLadder: no overlap between supported efforts (${supported.join(", ")}) ` +
        `and the allow-list (${(allowed ?? []).join(", ")}).`,
    );
  }
  return ladder;
}
