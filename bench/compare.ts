/**
 * Paired comparison of two benchmark runs of (nominally) the same model, e.g. the hand-rolled
 * Clef server against Ollama's: same items, so every answer can be compared one to one.
 *
 *   node bench/compare.ts clef-flash-gpu clef-flash-ollama-gpu
 *
 * Prints markdown to stdout: accuracy per task and language, answer agreement, probability
 * drift, the items whose correctness changed, latency per task, question scaling and memory.
 */
import { readFileSync } from "node:fs";
import { mean, percentile, summarizeLatency, type Prediction } from "./lib/metrics.ts";
import type { TaskInfo } from "./tasks.ts";
import type { Call } from "./lib/timed-fetch.ts";

interface CaseRecord {
  readonly task: string;
  readonly id: string;
  readonly lang: string;
  readonly calls: Call[];
  readonly predictions?: Record<string, Prediction>;
  readonly error?: string;
}

interface RunResult {
  readonly run: { readonly label: string; readonly device: string; readonly modelId: string };
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

const [baseLabel, candLabel] = process.argv.slice(2);
if (!baseLabel || !candLabel) {
  console.error("usage: node bench/compare.ts <baseline-label> <candidate-label>");
  process.exit(1);
}

function load(label: string): RunResult {
  return JSON.parse(
    readFileSync(new URL(`./results/${label}.json`, import.meta.url), "utf8"),
  ) as RunResult;
}

const base = load(baseLabel);
const cand = load(candLabel);
// Ids are only unique within a task and language: language and fast-path share their prompts,
// and the parallel public sets (MASSIVE, XNLI, PAWS-X) reuse one id for the EN and FR copy.
const caseKey = (c: CaseRecord) => `${c.task}/${c.lang}/${c.id}`;
const candById = new Map(cand.cases.map((c) => [caseKey(c), c]));

/** Cases answered in both runs, keyed by task/lang. */
const pairs = base.cases.flatMap((b) => {
  const c = candById.get(caseKey(b));
  return c?.predictions && b.predictions ? [{ base: b, cand: c }] : [];
});

const pct = (value: number) => (Number.isNaN(value) ? "–" : (value * 100).toFixed(1));
const signed = (value: number, digits = 1) =>
  Number.isNaN(value) ? "–" : `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
const ms = (value: number) => (Number.isNaN(value) ? "–" : Math.round(value).toString());
const gib = (value: number | undefined) =>
  value === undefined ? "–" : `${(value / 1024).toFixed(1)} GiB`;

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map((_, index) => (index === 0 ? "---" : "---:")).join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

const out: string[] = [`# ${baseLabel} vs ${candLabel}`, ""];
out.push(
  `${pairs.length} items answered by both (${base.cases.length} / ${cand.cases.length} cases, ` +
    `${base.cases.filter((c) => c.error).length} / ${cand.cases.filter((c) => c.error).length} errors).`,
  "",
);

// --- quality, paired ----------------------------------------------------------------------------

/** The scored field of each task (the first one, as bench/report.ts does). */
const scoredField = new Map(base.tasks.map((t) => [t.name, Object.keys(t.fields)[0]!]));
const groups = [...new Set(pairs.map((p) => `${p.base.task}/${p.base.lang}`))];
const qualityRows: string[][] = [];
const headline: Record<string, { base: number[]; cand: number[] }> = {};
for (const group of groups) {
  const [task, lang] = group.split("/") as [string, string];
  const field = scoredField.get(task)!;
  const inGroup = pairs
    .map((p) => ({ b: p.base.predictions![field], c: p.cand.predictions![field] }))
    .filter((_, index) => `${pairs[index]!.base.task}/${pairs[index]!.base.lang}` === group)
    .filter((p): p is { b: Prediction; c: Prediction } => p.b !== undefined && p.c !== undefined);
  if (inGroup.length === 0) continue;
  // Effort has no ground truth: only agreement means anything there.
  const scored = task !== "effort";
  const baseAcc = scored ? mean(inGroup.map((p) => (p.b.predicted === p.b.gold ? 1 : 0))) : NaN;
  const candAcc = scored ? mean(inGroup.map((p) => (p.c.predicted === p.c.gold ? 1 : 0))) : NaN;
  const agreement = mean(inGroup.map((p) => (p.b.predicted === p.c.predicted ? 1 : 0)));
  const drift = inGroup
    .filter((p) => p.b.probabilities && p.c.probabilities)
    .map((p) =>
      Math.abs((p.c.probabilities![p.b.predicted] ?? 0) - p.b.probabilities![p.b.predicted]!),
    );
  qualityRows.push([
    group,
    String(inGroup.length),
    pct(baseAcc),
    pct(candAcc),
    signed((candAcc - baseAcc) * 100),
    pct(agreement),
    drift.length > 0 ? mean(drift).toFixed(3) : "–",
    drift.length > 0 ? percentile(drift, 95).toFixed(3) : "–",
  ]);
  if (scored && (lang === "en" || lang === "fr")) {
    headline[lang] ??= { base: [], cand: [] };
    headline[lang].base.push(baseAcc);
    headline[lang].cand.push(candAcc);
  }
}

out.push("## Quality (paired items)", "");
out.push(
  "_Agree_ = same top answer. _Δp_ = |change in the probability of the baseline's answer|.",
  "",
);
out.push(
  table(
    ["task/lang", "n", `${baseLabel} %`, `${candLabel} %`, "Δ pts", "Agree %", "mean Δp", "p95 Δp"],
    qualityRows,
  ),
  "",
);
for (const [lang, values] of Object.entries(headline)) {
  const b = mean(values.base) * 100;
  const c = mean(values.cand) * 100;
  out.push(
    `- Mean accuracy ${lang.toUpperCase()} over ${values.base.length} tasks: ${b.toFixed(1)} → ${c.toFixed(1)} (${signed(c - b)} pts)`,
  );
}

// Overall agreement across every scored field, not just the headline one.
const allFields = pairs.flatMap((p) =>
  Object.keys(p.base.predictions!)
    .filter((name) => p.cand.predictions![name])
    .map((name) => p.base.predictions![name]!.predicted === p.cand.predictions![name]!.predicted),
);
out.push(`- Agreement over every field of every item: ${pct(mean(allFields.map(Number)))}%`, "");

// --- items whose correctness changed ------------------------------------------------------------

const APP_TASKS = new Set(["language", "fast-path", "injection"]);
const flips = pairs.flatMap((p) => {
  if (p.base.task === "effort") return [];
  return Object.keys(p.base.predictions!).flatMap((name) => {
    const b = p.base.predictions![name]!;
    const c = p.cand.predictions![name];
    if (!c || (b.predicted === b.gold) === (c.predicted === c.gold)) return [];
    return [
      {
        task: p.base.task,
        id: p.base.id,
        field: name,
        gold: b.gold,
        b: b.predicted,
        c: c.predicted,
        fixed: c.predicted === c.gold,
      },
    ];
  });
});
const appFlips = flips.filter((f) => APP_TASKS.has(f.task));
out.push("## Correctness changes", "");
out.push(
  `${flips.filter((f) => !f.fixed).length} new errors, ${flips.filter((f) => f.fixed).length} fixes ` +
    `(app tasks: ${appFlips.filter((f) => !f.fixed).length} new errors, ${appFlips.filter((f) => f.fixed).length} fixes).`,
  "",
);
if (appFlips.length > 0) {
  out.push(
    table(
      ["id", "field", "gold", baseLabel, candLabel, ""],
      appFlips.map((f) => [f.id, f.field, f.gold, f.b, f.c, f.fixed ? "fixed" : "**new error**"]),
    ),
    "",
  );
}

// --- latency ------------------------------------------------------------------------------------

const okMs = (cases: readonly CaseRecord[]) =>
  cases.flatMap((c) => c.calls.filter((call) => call.status === 200).map((call) => call.ms));
out.push("## Latency (ms)", "");
const tasks = [...new Set(base.cases.map((c) => c.task))];
const latencyRows = [
  ["all", base.cases, cand.cases] as const,
  ...tasks.map(
    (task) =>
      [
        task,
        base.cases.filter((c) => c.task === task),
        cand.cases.filter((c) => c.task === task),
      ] as const,
  ),
].map(([name, b, c]) => {
  const lb = summarizeLatency(okMs(b));
  const lc = summarizeLatency(okMs(c));
  return [name, ms(lb.p50), ms(lc.p50), ms(lb.p95), ms(lc.p95), `${(lc.p50 / lb.p50).toFixed(2)}×`];
});
out.push(
  table(
    [
      "task",
      `${baseLabel} p50`,
      `${candLabel} p50`,
      `${baseLabel} p95`,
      `${candLabel} p95`,
      "p50 ratio",
    ],
    latencyRows,
  ),
  "",
);
const all = summarizeLatency(okMs(cand.cases));
out.push(
  `- ${candLabel} slow? ${all.p50 > 1000 || all.p95 > 2000 ? "**slow**" : "ok"} (p50 ${ms(all.p50)}, p95 ${ms(all.p95)}; slow = p50 > 1000 or p95 > 2000)`,
  "",
);

out.push("### Latency vs number of questions (p50 ms)", "");
out.push(
  table(
    ["questions", baseLabel, candLabel],
    Object.keys(base.scaling).map((count) => [
      count,
      ms(
        percentile(
          base.scaling[count]!.map((call) => call.ms),
          50,
        ),
      ),
      ms(
        percentile(
          (cand.scaling[count] ?? []).map((call) => call.ms),
          50,
        ),
      ),
    ]),
  ),
  "",
);

// --- resources ----------------------------------------------------------------------------------

const vramDelta = (r: RunResult) =>
  r.memory.peakVramMiB !== undefined && r.memory.baselineVramMiB !== undefined
    ? r.memory.peakVramMiB - r.memory.baselineVramMiB
    : undefined;
out.push("## Resources", "");
out.push(
  table(
    ["", baseLabel, candLabel],
    [
      ["model id", `\`${base.run.modelId}\``, `\`${cand.run.modelId}\``],
      [
        "cold start",
        base.coldStartMs ? `${(base.coldStartMs / 1000).toFixed(1)} s` : "–",
        cand.coldStartMs ? `${(cand.coldStartMs / 1000).toFixed(1)} s` : "–",
      ],
      ["peak VRAM (above baseline)", gib(vramDelta(base)), gib(vramDelta(cand))],
      ["peak VRAM (absolute)", gib(base.memory.peakVramMiB), gib(cand.memory.peakVramMiB)],
      ["peak container RAM", gib(base.memory.peakRamMiB), gib(cand.memory.peakRamMiB)],
    ],
  ),
);

console.log(out.join("\n"));
