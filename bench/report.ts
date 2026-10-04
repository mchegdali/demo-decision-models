/**
 * Compiles bench/results/*.json (and *.failed.json) into docs/BENCHMARK_RESULTS.md.
 * Hand-written analysis lives in bench/findings.md and is inserted verbatim.
 *
 *   node bench/report.ts
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  mean,
  percentile,
  summarizeLatency,
  summarizeQuality,
  type LatencySummary,
  type Prediction,
  type QualitySummary,
} from "./lib/metrics.ts";
import type { TaskInfo } from "./tasks.ts";
import type { Call } from "./lib/timed-fetch.ts";

/** "Slow" thresholds agreed for this benchmark (see the Method section). */
const SLOW_P50_MS = 1000;
const SLOW_P95_MS = 2000;
const LOW_PREFILL_TOKENS_PER_S = 500;

interface CaseRecord {
  readonly task: string;
  readonly id: string;
  readonly lang: "en" | "fr" | "other";
  readonly calls: Call[];
  readonly predictions?: Record<string, Prediction>;
  readonly error?: string;
}

interface RunResult {
  readonly run: {
    readonly label: string;
    readonly device: string;
    readonly modelId: string;
    readonly notes?: string;
    readonly startedAt: string;
    readonly wallSeconds: number;
    readonly limit?: number;
  };
  readonly coldStartMs?: number;
  readonly memory: {
    readonly peakVramMiB?: number;
    readonly peakRamMiB?: number;
    readonly baselineVramMiB?: number;
  };
  readonly tasks: TaskInfo[];
  readonly cases: CaseRecord[];
  readonly scaling: Record<string, Call[]>;
}

interface FailedRun {
  readonly label: string;
  readonly device: string;
  readonly reason: string;
}

const resultsDir = new URL("./results/", import.meta.url);
const files = existsSync(resultsDir) ? readdirSync(resultsDir).sort() : [];
const runs: RunResult[] = files
  .filter((file) => file.endsWith(".json") && !file.endsWith(".failed.json"))
  .map((file) => JSON.parse(readFileSync(new URL(file, resultsDir), "utf8")) as RunResult);
const failed: FailedRun[] = files
  .filter((file) => file.endsWith(".failed.json"))
  .map((file) => JSON.parse(readFileSync(new URL(file, resultsDir), "utf8")) as FailedRun);

const MODEL_ORDER = [
  "jev",
  "clef-flash",
  "clef-flash-ollama",
  "clef",
  "clef-ollama",
  "kev-0.8b",
  "kev-4b",
  "kev-9b",
  "nimble",
  "tev1-0.8b",
  "tev1-4b",
  "laya",
  "laya-typed",
];
function modelOf(label: string): string {
  return label.replace(/-(gpu|cpu|hosted)$/, "");
}
function sortKey(label: string): string {
  const index = MODEL_ORDER.indexOf(modelOf(label));
  return `${String(index < 0 ? 99 : index).padStart(2, "0")}-${label}`;
}
runs.sort((left, right) => sortKey(left.run.label).localeCompare(sortKey(right.run.label)));

// --- formatting -------------------------------------------------------------------------------

const ms = (value: number | undefined) =>
  value === undefined || Number.isNaN(value)
    ? "–"
    : value >= 10000
      ? `${(value / 1000).toFixed(1)} s`
      : `${Math.round(value)}`;
const pct = (value: number | undefined) =>
  value === undefined || Number.isNaN(value) ? "–" : `${(value * 100).toFixed(1)}`;
const num = (value: number | undefined, digits = 3) =>
  value === undefined || Number.isNaN(value) ? "–" : value.toFixed(digits);
const mib = (value: number | undefined) =>
  value === undefined || Number.isNaN(value) ? "–" : `${(value / 1024).toFixed(1)} GiB`;

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map((_, index) => (index === 0 ? "---" : "---:")).join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

// --- aggregation ------------------------------------------------------------------------------

function okCalls(cases: readonly CaseRecord[]): Call[] {
  return cases.flatMap((c) => c.calls.filter((call) => call.status === 200));
}

function latency(cases: readonly CaseRecord[]): LatencySummary {
  return summarizeLatency(okCalls(cases).map((call) => call.ms));
}

interface RunSummary {
  readonly result: RunResult;
  readonly latency: LatencySummary;
  readonly slow: boolean;
  readonly prefillTokensPerS: number | undefined;
  readonly decisionsPerS: number;
  readonly errors: number;
  readonly vramDeltaMiB: number | undefined;
}

function summarizeRun(result: RunResult): RunSummary {
  const calls = okCalls(result.cases);
  const lat = summarizeLatency(calls.map((call) => call.ms));
  const seconds = calls.reduce((sum, call) => sum + call.ms, 0) / 1000;
  const withTokens = calls.filter((call) => call.inputTokens !== undefined);
  const tokenSeconds = withTokens.reduce((sum, call) => sum + call.ms, 0) / 1000;
  return {
    result,
    latency: lat,
    slow: lat.p50 > SLOW_P50_MS || lat.p95 > SLOW_P95_MS,
    prefillTokensPerS:
      withTokens.length > 0
        ? withTokens.reduce((sum, call) => sum + call.inputTokens!, 0) / tokenSeconds
        : undefined,
    decisionsPerS: calls.reduce((sum, call) => sum + call.questions, 0) / seconds,
    errors: result.cases.filter((c) => c.error).length,
    vramDeltaMiB:
      result.run.device === "gpu" &&
      result.memory.peakVramMiB !== undefined &&
      result.memory.baselineVramMiB !== undefined
        ? result.memory.peakVramMiB - result.memory.baselineVramMiB
        : undefined,
  };
}

function quality(
  result: RunResult,
  task: string,
  lang: string,
  field?: string,
): QualitySummary | undefined {
  const info = result.tasks.find((t) => t.name === task);
  if (!info) return undefined;
  const name = field ?? Object.keys(info.fields)[0]!;
  const labels = info.fields[name] ?? [];
  // Failed requests carry no prediction; they are counted in the summary's Errors column.
  const predictions = result.cases
    .filter((c) => c.task === task && c.lang === lang)
    .map((c) => c.predictions?.[name])
    .filter((p): p is Prediction => p !== undefined);
  if (predictions.length === 0) return undefined;
  // Fields without a fixed label set (location) are scored on exact match only.
  const labelSet = labels.length > 0 ? labels : [...new Set(predictions.map((p) => p.gold))];
  return summarizeQuality(predictions, labelSet);
}

function sentimentMae(result: RunResult, lang: string): number | undefined {
  const levels = ["negative", "neutral", "positive"];
  const scored = result.cases
    .filter(
      (c) =>
        c.task === "sentiment" && c.lang === lang && c.predictions?.sentiment?.score !== undefined,
    )
    .map((c) =>
      Math.abs(c.predictions!.sentiment!.score! - levels.indexOf(c.predictions!.sentiment!.gold)),
    );
  return scored.length > 0 ? mean(scored) : undefined;
}

/** Share of effort prompts whose EN and FR versions land on the same tier. */
function effortAgreement(result: RunResult): number | undefined {
  const byId = new Map<string, Record<string, string>>();
  for (const c of result.cases.filter((c) => c.task === "effort" && c.predictions)) {
    const base = c.id.replace(/-(en|fr)$/, "");
    byId.set(base, { ...byId.get(base), [c.lang]: c.predictions!.tier!.predicted });
  }
  const pairs = [...byId.values()].filter((pair) => pair.en && pair.fr);
  return pairs.length > 0 ? mean(pairs.map((pair) => (pair.en === pair.fr ? 1 : 0))) : undefined;
}

const summaries = runs.map(summarizeRun);
const QUALITY_TASKS = [
  "language",
  "fast-path",
  "injection",
  "massive",
  "xnli",
  "pawsx",
  "sentiment",
] as const;

function headlineAccuracy(result: RunResult, lang: "en" | "fr"): number | undefined {
  const values = QUALITY_TASKS.map((task) => quality(result, task, lang)?.accuracy).filter(
    (value): value is number => value !== undefined,
  );
  return values.length === QUALITY_TASKS.length ? mean(values) : undefined;
}

// --- document ---------------------------------------------------------------------------------

const sections: string[] = [];

sections.push(`# Decision model benchmark results

Open System One / Jev-compatible decision models, zero-shot (no finetuning) on English and French
evals, each run once on the GPU and once on the CPU of one desktop machine to judge whether they
are usable at the edge. Generated by \`node bench/report.ts\` from \`bench/results/\`; the
commentary in *Findings* is hand-written in \`bench/findings.md\`.`);

const findingsPath = new URL("./findings.md", import.meta.url);
if (existsSync(findingsPath)) sections.push(readFileSync(findingsPath, "utf8").trim());

sections.push(`## Summary

**Slow** = p50 request latency > ${SLOW_P50_MS} ms **or** p95 > ${SLOW_P95_MS} ms, over every eval
request of the run (one full \`/v1/systemone\` call, 1–7 questions; see Method). *Accuracy* is the
unweighted mean over the seven scored tasks.

${table(
  [
    "Run",
    "Device",
    "p50 ms",
    "p95 ms",
    "Slow?",
    "Cold start",
    "Peak VRAM",
    "Peak RAM",
    "Acc. EN",
    "Acc. FR",
    "Errors",
  ],
  summaries.map((s) => [
    `\`${s.result.run.label}\``,
    s.result.run.device,
    ms(s.latency.p50),
    ms(s.latency.p95),
    s.slow ? "**slow**" : "ok",
    ms(s.result.coldStartMs),
    mib(s.vramDeltaMiB),
    mib(s.result.memory.peakRamMiB),
    pct(headlineAccuracy(s.result, "en")),
    pct(headlineAccuracy(s.result, "fr")),
    String(s.errors),
  ]),
)}`);

if (failed.length > 0) {
  sections.push(`### Runs that failed or were stopped

${table(
  ["Run", "Device", "Reason"],
  failed.map((f) => [
    `\`${f.label}\``,
    f.device,
    f.reason.replaceAll("\n", " ").replaceAll("|", "\\|"),
  ]),
)}`);
}

sections.push(`## Quality by task

Accuracy (%) per language. Parallel corpora (MASSIVE, XNLI, PAWS-X) and all app sets use the same
items in both languages, so *EN−FR* is a like-for-like gap. Language detection's *other* column is
15 non-EN/FR or contentless inputs.

${table(
  [
    "Run",
    ...QUALITY_TASKS.flatMap((task) =>
      task === "language" ? [`${task} EN`, "FR", "other"] : [`${task} EN`, "FR"],
    ),
    "Mean EN−FR",
  ],
  summaries.map((s) => {
    const r = s.result;
    const gaps = QUALITY_TASKS.map((task) => {
      const en = quality(r, task, "en")?.accuracy;
      const fr = quality(r, task, "fr")?.accuracy;
      return en !== undefined && fr !== undefined ? en - fr : undefined;
    }).filter((value): value is number => value !== undefined);
    return [
      `\`${r.run.label}\``,
      ...QUALITY_TASKS.flatMap((task) => {
        const cells = [
          pct(quality(r, task, "en")?.accuracy),
          pct(quality(r, task, "fr")?.accuracy),
        ];
        return task === "language" ? [...cells, pct(quality(r, task, "other")?.accuracy)] : cells;
      }),
      gaps.length > 0 ? `${(mean(gaps) * 100).toFixed(1)} pts` : "–",
    ];
  }),
)}

### Macro-F1, calibration and secondary fields

Macro-F1 (%) and Brier (lower is better) pooled over EN+FR; ECE is the top-label expected
calibration error. Fast-path *place* / *day* are scored only where code would answer with them.

${table(
  [
    "Run",
    "MASSIVE F1",
    "XNLI F1",
    "PAWS-X F1",
    "Sentiment F1",
    "Sentiment MAE",
    "Injection F1",
    "Brier (choice/bool)",
    "ECE",
    "Fast-path place",
    "Fast-path day",
    "Effort EN=FR",
  ],
  summaries.map((s) => {
    const r = s.result;
    const pooled = (task: string, field?: string) => {
      const en = quality(r, task, "en", field);
      const fr = quality(r, task, "fr", field);
      return en && fr ? { en, fr } : undefined;
    };
    const avg = (task: string, pick: (q: QualitySummary) => number | undefined, field?: string) => {
      const both = pooled(task, field);
      if (!both) return undefined;
      const values = [pick(both.en), pick(both.fr)].filter(
        (value): value is number => value !== undefined,
      );
      return values.length === 2 ? mean(values) : undefined;
    };
    const calibrated = ["massive", "xnli", "pawsx", "injection"];
    const brierValues = calibrated
      .map((task) => avg(task, (q) => q.brier))
      .filter((v): v is number => v !== undefined);
    const eceValues = calibrated
      .map((task) => avg(task, (q) => q.ece))
      .filter((v): v is number => v !== undefined);
    const maes = ["en", "fr"]
      .map((lang) => sentimentMae(r, lang))
      .filter((v): v is number => v !== undefined);
    return [
      `\`${r.run.label}\``,
      pct(avg("massive", (q) => q.macroF1)),
      pct(avg("xnli", (q) => q.macroF1)),
      pct(avg("pawsx", (q) => q.macroF1)),
      pct(avg("sentiment", (q) => q.macroF1)),
      num(maes.length === 2 ? mean(maes) : undefined),
      pct(avg("injection", (q) => q.macroF1)),
      num(brierValues.length === calibrated.length ? mean(brierValues) : undefined),
      num(eceValues.length === calibrated.length ? mean(eceValues) : undefined),
      pct(avg("fast-path", (q) => q.accuracy, "location")),
      pct(avg("fast-path", (q) => q.accuracy, "when")),
      pct(effortAgreement(r)),
    ];
  }),
)}`);

const LATENCY_TASKS = [
  "language",
  "massive",
  "xnli",
  "pawsx",
  "sentiment",
  "fast-path",
  "injection",
  "effort",
];
sections.push(`## Latency and throughput

p50 request latency (ms) per task; the \`(Nq)\` in each column header is that task's questions per request.
*Prefill tok/s* uses the server's own \`usage.input_tokens\`, which servers count differently
(Nimble counts its prompt once per question, Laya once per question row), so compare it within
a model across devices rather than across models. A value under ${LOW_PREFILL_TOKENS_PER_S} tok/s is flagged.

${table(
  [
    "Run",
    ...LATENCY_TASKS.map(
      (task) =>
        `${task} (${task === "effort" ? 7 : task === "injection" ? 5 : task === "fast-path" ? 4 : 1}q)`,
    ),
    "p99 ms",
    "Decisions/s",
    "Prefill tok/s",
  ],
  summaries.map((s) => [
    `\`${s.result.run.label}\``,
    ...LATENCY_TASKS.map((task) => ms(latency(s.result.cases.filter((c) => c.task === task)).p50)),
    ms(s.latency.p99),
    num(s.decisionsPerS, 1),
    s.prefillTokensPerS === undefined
      ? "–"
      : `${Math.round(s.prefillTokensPerS)}${s.prefillTokensPerS < LOW_PREFILL_TOKENS_PER_S ? " ⚠" : ""}`,
  ]),
)}

### Latency vs number of questions

Same states (the 15 EN effort prompts, round-robin), asking the first 1, 2, 4 or all 7
effort-evaluator questions; p50 ms over 20 requests each. Prompts rotate so servers that cache a
repeated prompt prefix can't answer from cache.

${table(
  ["Run", "1 question", "2", "4", "7", "7 ÷ 1"],
  summaries.map((s) => {
    const p50 = (count: string) =>
      percentile(
        (s.result.scaling[count] ?? []).filter((c) => c.status === 200).map((c) => c.ms),
        50,
      );
    const ratio = p50("7") / p50("1");
    return [
      `\`${s.result.run.label}\``,
      ms(p50("1")),
      ms(p50("2")),
      ms(p50("4")),
      ms(p50("7")),
      Number.isNaN(ratio) ? "–" : `${ratio.toFixed(1)}×`,
    ];
  }),
)}`);

sections.push(`## Run configuration

${table(
  ["Run", "Model id", "Items", "Wall time", "Server configuration"],
  summaries.map((s) => [
    `\`${s.result.run.label}\``,
    `\`${s.result.run.modelId}\``,
    `${s.result.cases.length}${s.result.run.limit ? ` (≤${s.result.run.limit}/task/lang)` : ""}`,
    `${(s.result.run.wallSeconds / 60).toFixed(1)} min`,
    s.result.run.notes ? `\`${s.result.run.notes}\`` : "hosted API",
  ]),
)}`);

const methodPath = new URL("./method.md", import.meta.url);
if (existsSync(methodPath)) sections.push(readFileSync(methodPath, "utf8").trim());

mkdirSync(new URL("../docs/", import.meta.url), { recursive: true });
const out = new URL("../docs/BENCHMARK_RESULTS.md", import.meta.url);
writeFileSync(out, `${sections.join("\n\n")}\n`);
console.log(`wrote ${out.pathname} (${runs.length} runs, ${failed.length} failed)`);
