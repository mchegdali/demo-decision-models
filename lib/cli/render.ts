import type { EffortVerdict } from "../../features/agents/classifiers/effort-evaluator/index.ts";
import type { PromptInjectionVerdict } from "../../features/agents/classifiers/prompt-injection-detector/index.ts";
import type { ExploreDocsResult } from "../../features/agents/docs-explorer/index.ts";

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
