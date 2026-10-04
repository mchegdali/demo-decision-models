import { formatFastToolVerdict, formatLanguageVerdict } from "../lib/cli/index.ts";
import { evaluatorEnv } from "../lib/env.ts";

interface Sample {
  readonly prompt: string;
  readonly language: "fr" | "en" | "other";
  /** `handle:<intent>` when code should answer, or `defer` for the full pipeline. */
  readonly route: string;
}

/** Spans every branch: greeting, time, weather (with and without a city), and each way to defer. */
const SAMPLES: readonly Sample[] = [
  { prompt: "dis juste bonjour", language: "fr", route: "handle:greeting" },
  { prompt: "hello", language: "en", route: "handle:greeting" },
  { prompt: "quelle heure est-il à Tokyo ?", language: "fr", route: "handle:time" },
  { prompt: "what time is it?", language: "en", route: "handle:time" },
  { prompt: "what's the weather in Paris tomorrow", language: "en", route: "handle:weather" },
  { prompt: "il fait quel temps ?", language: "fr", route: "handle:weather" },
  { prompt: "Wie spät ist es in Berlin?", language: "other", route: "handle:time" },
  // Must defer: a real question behind a greeting, a plain docs question, an unsupported day.
  {
    prompt: "bonjour, comment configurer stopWhen dans l'AI SDK ?",
    language: "fr",
    route: "defer",
  },
  { prompt: "What's the default port for Vite?", language: "en", route: "defer" },
  { prompt: "quel temps fera-t-il ce weekend à Lyon ?", language: "fr", route: "defer" },
  { prompt: "what was the weather like in Paris yesterday?", language: "en", route: "defer" },
] as const;

/** Runs the language-detector and fast-tool-detector classifiers against sample prompts. */
export async function runFastPathDemo(): Promise<void> {
  console.log("\n=== language-detector + fast-tool-detector ===");
  const { detectLanguage } =
    await import("../features/agents/classifiers/language-detector/index.ts");
  const { detectFastTool, isHandled } =
    await import("../features/agents/classifiers/fast-tool-detector/index.ts");

  let mismatches = 0;
  for (const sample of SAMPLES) {
    const [language, fastTool] = await Promise.all([
      detectLanguage({ text: sample.prompt }),
      detectFastTool({ prompt: sample.prompt }),
    ]);

    const route = isHandled(fastTool) ? `handle:${fastTool.intent}` : "defer";
    const ok = language.language === sample.language && route === sample.route;
    if (!ok) mismatches++;

    console.log(`\n> ${JSON.stringify(sample.prompt)}`);
    console.log(formatLanguageVerdict(language));
    console.log(formatFastToolVerdict(fastTool));
    console.log(
      ok
        ? "ok"
        : `MISMATCH: expected language=${sample.language} route=${sample.route}, ` +
            `got language=${language.language} route=${route}`,
    );
  }

  console.log(`\n${SAMPLES.length - mismatches}/${SAMPLES.length} samples as expected.`);
}

// Only the evaluator is needed: this demo never imports the language model or docs-explorer.
const missing = evaluatorEnv().filter((name) => !process.env[name]);
if (missing.length === 0) {
  await runFastPathDemo();
} else {
  console.log(`Skipping fast-path demo: ${missing.join(", ")} must be set.`);
}
