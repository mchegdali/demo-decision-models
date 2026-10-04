/**
 * Runs every eval case against one /v1/systemone server, sequentially (one user at the edge),
 * and writes raw results to bench/results/<label>.json. bench/report.ts turns those into
 * docs/BENCHMARK_RESULTS.md.
 *
 *   node bench/run.ts --label clef-flash-ollama-gpu --base-url http://127.0.0.1:11434/v1 \
 *     --model-id clef-flash:9b-q8_0 --device gpu --container ollama [--limit 100] [--tasks massive,xnli]
 *
 * --api-key-env names an environment variable holding the key (e.g. TYPESAFE_AI_API_KEY for Jev).
 * --cold-start-ms / --baseline-vram-mib are measured by bench/containers.ps1 before this starts.
 * --ollama-url (an Ollama root, set by bench/pod/run.sh on RunPod) reads memory from its /api/ps
 * instead of the local GPU and container.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { experimental_evaluate as evaluate } from "ai";
import type { Prediction } from "./lib/metrics.ts";
import { startMemorySampler } from "./lib/memory-sampler.ts";
import { createTimedFetch, type Call } from "./lib/timed-fetch.ts";

const { values: args } = parseArgs({
  options: {
    label: { type: "string" },
    "base-url": { type: "string" },
    "model-id": { type: "string" },
    "api-key-env": { type: "string" },
    device: { type: "string" },
    container: { type: "string" },
    tasks: { type: "string" },
    limit: { type: "string" },
    warmup: { type: "string", default: "10" },
    "scaling-reps": { type: "string", default: "20" },
    "cold-start-ms": { type: "string" },
    "baseline-vram-mib": { type: "string" },
    "ollama-url": { type: "string" },
    notes: { type: "string" },
  },
});

function required(name: keyof typeof args): string {
  const value = args[name];
  if (typeof value !== "string" || value === "") throw new Error(`--${name} is required`);
  return value;
}

const label = required("label");
const baseURL = required("base-url");
const modelId = required("model-id");
const device = required("device");
const apiKey = args["api-key-env"] ? process.env[args["api-key-env"]] : undefined;
const optionalNumber = (value: string | undefined) => (value ? Number(value) : undefined);

// The classifier modules resolve the configured evaluator when imported: point it at this server.
process.env.EVALUATOR_BACKEND = "local";
process.env.EVALUATOR_BASE_URL = baseURL;
process.env.EVALUATOR_MODEL_ID = modelId;
if (apiKey) process.env.EVALUATOR_API_KEY = apiKey;

const { createEvaluatorModel } = await import("../lib/ai/evaluator-model.ts");
const { buildCases, loadClassifiers, scalingQuestions, scalingState, TASKS } =
  await import("./tasks.ts");

const timed = createTimedFetch();
const model = createEvaluatorModel({ baseURL, modelId, apiKey, fetch: timed.fetch });

/** Same rank for the EN and FR copy of an item, so a --limit keeps parallel pairs together. */
function rank(id: string): string {
  return createHash("sha256")
    .update(id.replace(/-(en|fr)$/, ""))
    .digest("hex");
}

let cases = buildCases(await loadClassifiers());
if (args.tasks) {
  const wanted = new Set(args.tasks.split(","));
  cases = cases.filter((c) => wanted.has(c.task));
}
const limit = optionalNumber(args.limit);
if (limit !== undefined) {
  const groups = new Map<string, typeof cases>();
  for (const c of cases)
    groups.set(`${c.task}/${c.lang}`, [...(groups.get(`${c.task}/${c.lang}`) ?? []), c]);
  cases = [...groups.values()].flatMap((group) =>
    [...group].sort((left, right) => rank(left.id).localeCompare(rank(right.id))).slice(0, limit),
  );
}

interface CaseRecord {
  readonly task: string;
  readonly id: string;
  readonly lang: string;
  readonly calls: Call[];
  readonly predictions?: Record<string, Prediction>;
  readonly error?: string;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : String(error);
}

// Warm-up: compile kernels, fill allocator pools, load lazily-routed checkpoints. Not recorded.
const warmup = Number(args.warmup);
console.log(`[${label}] warm-up: ${warmup} requests`);
for (const c of cases
  .filter((_, index) => index % Math.max(1, Math.floor(cases.length / warmup)) === 0)
  .slice(0, warmup)) {
  await timed.track(() => c.run(model));
}

const sampler = startMemorySampler(args.container, 2000, args["ollama-url"]);
const startedAt = new Date().toISOString();
const started = performance.now();
const records: CaseRecord[] = [];

console.log(`[${label}] ${cases.length} cases`);
for (const [index, c] of cases.entries()) {
  const { value, error, calls } = await timed.track(() => c.run(model));
  records.push({
    task: c.task,
    id: c.id,
    lang: c.lang,
    calls,
    predictions: value?.predictions as Record<string, Prediction> | undefined,
    error: error === undefined ? undefined : describe(error),
  });
  if ((index + 1) % 50 === 0 || index === cases.length - 1) {
    const elapsed = (performance.now() - started) / 1000;
    const eta = (elapsed / (index + 1)) * (cases.length - index - 1);
    const errors = records.filter((r) => r.error).length;
    console.log(
      `[${label}] ${index + 1}/${cases.length}  ${elapsed.toFixed(0)}s elapsed, ~${eta.toFixed(0)}s left, ${errors} errors`,
    );
  }
}

// Latency vs number of questions; repetition `rep` uses the same state for every count.
const reps = Number(args["scaling-reps"]);
const scaling: Record<string, Call[]> = {};
for (const [count, questions] of Object.entries(await scalingQuestions())) {
  const calls: Call[] = [];
  for (let rep = 0; rep < reps; rep++) {
    const tracked = await timed.track(() =>
      evaluate({ model, state: scalingState(rep), questions, maxRetries: 0 }),
    );
    calls.push(...tracked.calls);
  }
  scaling[count] = calls;
  console.log(`[${label}] scaling ${count} questions: ${reps} requests`);
}

const memory = await sampler.stop();
const result = {
  run: {
    label,
    device,
    baseURL,
    modelId,
    container: args.container,
    notes: args.notes,
    startedAt,
    wallSeconds: (performance.now() - started) / 1000,
    limit,
  },
  coldStartMs: optionalNumber(args["cold-start-ms"]),
  memory: { ...memory, baselineVramMiB: optionalNumber(args["baseline-vram-mib"]) },
  tasks: TASKS,
  cases: records,
  scaling,
};

mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
const out = new URL(`./results/${label}.json`, import.meta.url);
writeFileSync(out, JSON.stringify(result, null, 1));
console.log(`[${label}] wrote ${out.pathname}`);
