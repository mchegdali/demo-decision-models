# Benchmarks on RunPod

Runs that need more VRAM than the desktop's 12 GB run on a rented RunPod pod. Ollama and the
bench client (`bench/run.ts`) run together on the pod, so latencies are loopback and carry no
network round trip; the data center can therefore be picked by GPU stock and price alone.

## Pieces

- **Network volume, one per data center** (50 GB, STANDARD), mounted on `/workspace`. It keeps
  the Ollama weights (pulled by the first pod in that DC, reused after), Node, pnpm and the pnpm
  store, plus each run's `results/` and `logs/`. Only DCs with RunPod's S3-compatible API qualify,
  since results come back through it: EU-CZ-1, EU-RO-1, EUR-IS-1, EUR-NO-1, US-CA-2, US-GA-2,
  US-IL-1, US-KS-2, US-MD-1, US-MO-1, US-MO-2, US-NC-1, US-NC-2, US-NE-1, US-WA-1.
- **Template `bench-ollama`**: image `ollama/ollama:0.35.1`, container disk 20 GB, volume
  mount `/workspace`, no exposed ports, entrypoint `bash -c` and start command:

  ```sh
  apt-get update && apt-get install -y --no-install-recommends curl xz-utils ca-certificates libatomic1 && mkdir -p /src && curl -fsSL https://codeload.github.com/mchegdali/demo-decision-models/tar.gz/$BENCH_REF | tar xz -C /src --strip-components=1 && exec bash /src/bench/pod/run.sh
  ```

- **`bench/pod/run.sh`** (on the pod): starts Ollama on the volume, installs Node/pnpm and the
  dependencies, pulls the model (untimed), times the first decision (cold start = weight load
  from the volume + first decision), runs `bench/run.ts` against `127.0.0.1`, writes the result
  to the volume, then idles: the pod can't delete itself (its injected key gets 403) and an
  exiting container would be restarted, so whoever started it deletes it.
- **`bench/remote.ps1`** (on the desktop): polls the volume over S3 and downloads the result
  and logs into `bench/results/` and `bench/logs/`.

## One run

1. Push the commit to benchmark (the pod downloads it from GitHub by sha).
2. Pick a DC with the GPU in stock and S3 support; create its volume if it has none yet.
3. Create a pod from `bench-ollama` on that volume with env `BENCH_REF` (commit sha),
   `BENCH_LABEL`, `BENCH_MODEL_ID`, `BENCH_GPU` (display name for the notes) and optionally
   `BENCH_LIMIT`, `BENCH_TASKS`, `BENCH_NOTES`.
4. `./bench/remote.ps1 -Label <label> -VolumeId <volume id> -DataCenter <DC>`, then
   `pnpm bench:report`.
5. Delete the pod (also after a failure): it idles once the run ends, still billed.

S3 credentials go in `.env` as `RUNPOD_S3_ACCESS_KEY` (RunPod user id, `user_…`) and
`RUNPOD_S3_SECRET_KEY` (an S3 API key, `rps_…`, from RunPod settings).

Current resources: template `bench-ollama` = `ctx24jfoo5`; volumes: EUR-IS-1 = `bg5aw95nnt`.
