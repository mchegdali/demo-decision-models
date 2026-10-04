#!/usr/bin/env bash
# Benchmarks one Ollama decision model from inside a RunPod pod: Ollama and bench/run.ts share
# the pod, so latencies are loopback (no network round trip). Started by the bench-ollama
# template's bootstrap (see bench/pod/README.md) with a network volume mounted on /workspace:
#
#   /workspace/ollama              OLLAMA_MODELS, pulled once per data center
#   /workspace/cache               Node, pnpm and the pnpm store
#   /workspace/results/<label>.json | <label>.failed.json
#   /workspace/logs/<label>.log | <label>.ollama.log
#
# Env: BENCH_LABEL, BENCH_MODEL_ID, BENCH_GPU (required); BENCH_LIMIT, BENCH_TASKS, BENCH_NOTES
# optional.
set -euo pipefail

: "${BENCH_LABEL:?}" "${BENCH_MODEL_ID:?}" "${BENCH_GPU:?}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VOLUME=/workspace
OLLAMA=http://127.0.0.1:11434
READY_TIMEOUT_SEC=1800
NOTES="${BENCH_NOTES:-ollama/ollama:0.35.1 OLLAMA_CONTEXT_LENGTH=4096 OLLAMA_KEEP_ALIVE=-1}"
mkdir -p "$VOLUME/ollama" "$VOLUME/cache" "$VOLUME/results" "$VOLUME/logs"
# A previous run's files would look like this run's outcome to bench/remote.ps1.
rm -f "$VOLUME/results/$BENCH_LABEL.json" "$VOLUME/results/$BENCH_LABEL.failed.json" \
  "$VOLUME/logs/$BENCH_LABEL.log" "$VOLUME/logs/$BENCH_LABEL.ollama.log"
exec > >(tee -a "$VOLUME/logs/$BENCH_LABEL.log") 2>&1

step="start"
log() { echo "[$(date -u +%H:%M:%S)] [$BENCH_LABEL] $*"; }
now_ms() { date +%s%3N; }

# The pod can't delete itself (its injected RUNPOD_API_KEY gets 403), and RunPod restarts a
# container that exits, which would rerun the bench: idle until bench/remote.ps1's caller deletes it.
on_exit() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    local reason
    reason="$BENCH_LABEL failed during $step (exit $status)"
    reason="${reason//\\/\\\\}"
    printf '{\n  "label": "%s",\n  "device": "gpu",\n  "reason": "%s"\n}\n' \
      "$BENCH_LABEL" "${reason//\"/\\\"}" >"$VOLUME/results/$BENCH_LABEL.failed.json"
    log "FAILED during $step; see logs/$BENCH_LABEL.log"
  fi
  log "finished; delete pod ${RUNPOD_POD_ID:-}"
  sleep infinity
}
trap on_exit EXIT

step="ollama serve"
OLLAMA_MODELS="$VOLUME/ollama" OLLAMA_KEEP_ALIVE=-1 OLLAMA_CONTEXT_LENGTH=4096 \
  ollama serve >>"$VOLUME/logs/$BENCH_LABEL.ollama.log" 2>&1 &
for _ in $(seq 60); do curl -fsS "$OLLAMA/api/version" >/dev/null 2>&1 && break || sleep 1; done
curl -fsS "$OLLAMA/api/version" >/dev/null

step="node install"
node_version="$(tr -d '[:space:]' <"$ROOT/.nvmrc")"
node_dir="$VOLUME/cache/node-$node_version"
if [ ! -x "$node_dir/bin/node" ]; then
  log "installing Node $node_version into the volume"
  mkdir -p "$node_dir.tmp"
  curl -fsSL "https://nodejs.org/dist/$node_version/node-$node_version-linux-x64.tar.xz" |
    tar xJ -C "$node_dir.tmp" --strip-components=1 --no-same-owner # the volume refuses chown
  mv "$node_dir.tmp" "$node_dir"
fi
pnpm_version="$(sed -n 's/.*"packageManager": "pnpm@\([^"]*\)".*/\1/p' "$ROOT/package.json")"
pnpm_dir="$VOLUME/cache/pnpm-$pnpm_version"
export PATH="$node_dir/bin:$pnpm_dir/bin:$PATH"
[ -x "$pnpm_dir/bin/pnpm" ] || npm install --global --prefix "$pnpm_dir" "pnpm@$pnpm_version"

step="pnpm install"
(cd "$ROOT" && pnpm install --frozen-lockfile --store-dir "$VOLUME/cache/pnpm-store")

# Weights are pulled before timing, like containers.ps1 -Action pull; a no-op once on the volume.
step="ollama pull"
pull_started=$(now_ms)
ollama pull "$BENCH_MODEL_ID"
log "pulled in $((($(now_ms) - pull_started) / 1000)) s"

# Cold start: the model isn't loaded yet, so this is weight load from the volume + first decision.
step="first decision"
body="{\"model\":\"$BENCH_MODEL_ID\",\"state\":\"hello\",\"questions\":{\"greeting\":{\"type\":\"noul\",\"instructions\":\"Is this a greeting?\"}}}"
started=$(now_ms)
until curl -fsS --max-time 600 -H "Content-Type: application/json" -d "$body" \
  "$OLLAMA/v1/systemone" >/dev/null; do
  [ $((($(now_ms) - started) / 1000)) -lt "$READY_TIMEOUT_SEC" ] || exit 1
  sleep 1
done
cold_start=$(($(now_ms) - started))
log "cold start: $cold_start ms"

step="bench/run.ts"
args=(--label "$BENCH_LABEL" --base-url "$OLLAMA/v1" --model-id "$BENCH_MODEL_ID" --device gpu
  --container runpod --ollama-url "$OLLAMA" --cold-start-ms "$cold_start" --baseline-vram-mib 0
  --notes "$NOTES RunPod $BENCH_GPU ${RUNPOD_DC_ID:-}, bench client on the pod")
[ -n "${BENCH_LIMIT:-}" ] && [ "$BENCH_LIMIT" != 0 ] && args+=(--limit "$BENCH_LIMIT")
[ -n "${BENCH_TASKS:-}" ] && args+=(--tasks "$BENCH_TASKS")
node "$ROOT/bench/run.ts" "${args[@]}"

cp "$ROOT/bench/results/$BENCH_LABEL.json" "$VOLUME/results/$BENCH_LABEL.json"
rm -f "$VOLUME/results/$BENCH_LABEL.failed.json"
log "done: results/$BENCH_LABEL.json"
