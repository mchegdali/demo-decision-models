/** Quality and latency statistics for benchmark results. Pure functions, no I/O. */

export function mean(values: readonly number[]): number {
  return values.length === 0
    ? Number.NaN
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Linear-interpolated percentile, `p` in 0..100. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (rank - low);
}

export interface LatencySummary {
  readonly n: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly mean: number;
  readonly max: number;
}

export function summarizeLatency(ms: readonly number[]): LatencySummary {
  return {
    n: ms.length,
    p50: percentile(ms, 50),
    p95: percentile(ms, 95),
    p99: percentile(ms, 99),
    mean: mean(ms),
    max: ms.length === 0 ? Number.NaN : Math.max(...ms),
  };
}

/** One scored prediction. `probabilities` is the model's distribution over `labels`, when it gave one. */
export interface Prediction {
  readonly gold: string;
  readonly predicted: string;
  readonly probabilities?: Readonly<Record<string, number>>;
  /** Expected level of a Score answer, for MAE against the gold level. */
  readonly score?: number;
}

export interface QualitySummary {
  readonly n: number;
  readonly accuracy: number;
  readonly macroF1: number;
  /** Multiclass Brier score (sum over labels of squared error), lower is better. */
  readonly brier: number | undefined;
  /** Expected calibration error of the top-label confidence, 10 equal-width bins. */
  readonly ece: number | undefined;
}

export function macroF1(predictions: readonly Prediction[], labels: readonly string[]): number {
  const scores = labels
    .filter((label) => predictions.some((p) => p.gold === label))
    .map((label) => {
      const tp = predictions.filter((p) => p.gold === label && p.predicted === label).length;
      const fp = predictions.filter((p) => p.gold !== label && p.predicted === label).length;
      const fn = predictions.filter((p) => p.gold === label && p.predicted !== label).length;
      return tp === 0 ? 0 : (2 * tp) / (2 * tp + fp + fn);
    });
  return mean(scores);
}

function normalized(
  probabilities: Readonly<Record<string, number>>,
  labels: readonly string[],
): number[] {
  const raw = labels.map((label) => probabilities[label] ?? 0);
  const total = raw.reduce((sum, value) => sum + value, 0);
  return total > 0 ? raw.map((value) => value / total) : raw;
}

export function brier(
  predictions: readonly Prediction[],
  labels: readonly string[],
): number | undefined {
  const scored = predictions.filter((p) => p.probabilities !== undefined);
  if (scored.length === 0) return undefined;
  return mean(
    scored.map((p) =>
      normalized(p.probabilities!, labels).reduce(
        (sum, probability, index) => sum + (probability - (labels[index] === p.gold ? 1 : 0)) ** 2,
        0,
      ),
    ),
  );
}

export function ece(
  predictions: readonly Prediction[],
  labels: readonly string[],
  bins = 10,
): number | undefined {
  const scored = predictions.filter((p) => p.probabilities !== undefined);
  if (scored.length === 0) return undefined;
  const buckets = Array.from({ length: bins }, () => ({ confidence: 0, correct: 0, n: 0 }));
  for (const p of scored) {
    const distribution = normalized(p.probabilities!, labels);
    const confidence = Math.max(...distribution);
    const top = labels[distribution.indexOf(confidence)];
    const bucket = buckets[Math.min(bins - 1, Math.floor(confidence * bins))]!;
    bucket.confidence += confidence;
    bucket.correct += top === p.gold ? 1 : 0;
    bucket.n += 1;
  }
  return buckets.reduce(
    (sum, bucket) =>
      bucket.n === 0
        ? sum
        : sum +
          (bucket.n / scored.length) *
            Math.abs(bucket.correct / bucket.n - bucket.confidence / bucket.n),
    0,
  );
}

export function summarizeQuality(
  predictions: readonly Prediction[],
  labels: readonly string[],
): QualitySummary {
  return {
    n: predictions.length,
    accuracy: mean(predictions.map((p) => (p.gold === p.predicted ? 1 : 0))),
    macroF1: macroF1(predictions, labels),
    brier: brier(predictions, labels),
    ece: ece(predictions, labels),
  };
}
