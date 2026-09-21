import type { EffortVerdict } from "../../features/agents/classifiers/effort-evaluator/index.ts";
import type { FastToolVerdict } from "../../features/agents/classifiers/fast-tool-detector/index.ts";
import type { LanguageVerdict } from "../../features/agents/classifiers/language-detector/index.ts";
import type { PromptInjectionVerdict } from "../../features/agents/classifiers/prompt-injection-detector/index.ts";
import type { ExploreDocsResult } from "../../features/agents/docs-explorer/index.ts";

function formatConfidence(confidence: number | undefined): string {
  return confidence === undefined ? "n/a" : confidence.toFixed(2);
}

/** Formats a language verdict for console output. */
export function formatLanguageVerdict(verdict: LanguageVerdict): string {
  const lines = [
    `language=${verdict.language} raw=${verdict.rawChoice} confidence=${formatConfidence(verdict.confidence)}`,
    `probabilities=${JSON.stringify(verdict.probabilities ?? null)}`,
  ];
  return lines.join("\n");
}

/** Formats a fast-tool verdict for console output. */
export function formatFastToolVerdict(verdict: FastToolVerdict): string {
  const lines = [
    `fastTool=${verdict.action} intent=${verdict.intent} when=${verdict.when} ` +
      `location=${verdict.location ?? "-"} reason=${verdict.reason} ` +
      `confidence=${formatConfidence(verdict.confidence)}`,
    `signals=${JSON.stringify(verdict.signals)}`,
  ];
  return lines.join("\n");
}

/** Formats a prompt-injection verdict for console output. */
export function formatInjectionVerdict(verdict: PromptInjectionVerdict): string {
  const lines = [
    `action=${verdict.action} severity=${verdict.severity.toFixed(2)} triggered=[${verdict.triggered.join(", ")}]`,
    `signals=${JSON.stringify(verdict.signals)}`,
  ];
  return lines.join("\n");
}

/** Formats an effort verdict for console output. */
export function formatEffortVerdict(verdict: EffortVerdict): string {
  const confidence = verdict.confidence === undefined ? "n/a" : verdict.confidence.toFixed(2);
  const lines = [
    `tier=${verdict.tier} effort=${verdict.effort.toFixed(2)} maxSteps=${verdict.maxSteps} confidence=${confidence}`,
    `signals=${JSON.stringify(verdict.signals)}`,
  ];
  return lines.join("\n");
}

/** Formats a docs-explorer result for console output. */
export function formatDocsAnswer(result: ExploreDocsResult): string {
  const { answer, steps, usage } = result;
  const lines = [
    `found=${answer.found} confidence=${answer.confidence} steps=${steps} usage=${JSON.stringify(usage)}`,
    `answer: ${answer.answer || "(none)"}`,
  ];
  if (answer.followUp) lines.push(`followUp: ${answer.followUp}`);
  for (const citation of answer.citations) {
    lines.push(`- ${citation.title} <${citation.url}>: "${citation.quote}"`);
  }
  return lines.join("\n");
}
