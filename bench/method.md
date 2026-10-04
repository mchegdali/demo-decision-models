## Method

### Machine

|              |                                                                                  |
| ------------ | -------------------------------------------------------------------------------- |
| CPU          | AMD Ryzen 7 5800X, 8 cores / 16 threads (AVX2, no AVX-512 / BF16 instructions)   |
| GPU          | NVIDIA GeForce RTX 4070, 12 GB VRAM, driver 610.74                               |
| RAM          | 32 GB host; the container VM is capped at 26 GB (`wslc` `session.memorySize`)    |
| OS / runtime | Windows 11 Pro 26200, WSL 3.0.1 pre-release, `wslc` 3.0.1 containers (no Docker) |

Every server runs in a `wslc` container. GPU runs pass the GPU with `--gpus all`; CPU runs get no
GPU and 8 threads (the physical core count). `wslc` has no Compose support, so each
`infra/*/compose.yaml` service is translated to one `wslc run` in `bench/containers.ps1`.

### What "slow" means here

Decision models don't generate text: they answer every question in a single prefill pass, so
generation tokens/s and time-to-first-token don't apply. The agreed equivalents:

- **Slow** if the p50 latency of a full `/v1/systemone` request is over **1 s**, or the p95 is
  over **2 s**. A request is the decision's time-to-answer, so this is the "> 1 s to first token"
  rule applied to the whole decision. It is measured over every eval request of a run (1–7
  questions each), sequentially, as one edge user would send them.
- Also reported, not gating:
  - prefill throughput (input tokens/s), flagged under 500 tok/s;
  - decisions/s (questions answered per second of request time);
  - cold start: container start → first successful decision, including weight load;
  - peak memory: GPU memory above the pre-start baseline, and the container's RAM (which
    includes the page cache of weights read from disk);
  - how latency grows from 1 to 7 questions per request.

Latency is the HTTP round trip seen by the client (Node `fetch` on the same host), so it includes
JSON and the container's port forwarding, not SDK-side validation. Each run starts with 10
unrecorded warm-up requests. Kev's state-prefix cache is disabled (`KEV_PREFIX_CACHE=0`), and the
questions-count probe rotates prompts, so no server can answer a repeat from cache.

### Evals (EN/FR, zero-shot)

No model was finetuned or given examples. Each task asks the same English instructions; only the
input text is English or French. All questions are the ones the app ships with (app tasks) or a
single question written once for every model (public tasks).

| Task      | Kind                                                     |       Items per language | Question                                        | Scored                                                                        |
| --------- | -------------------------------------------------------- | -----------------------: | ----------------------------------------------- | ----------------------------------------------------------------------------- |
| language  | app: `language-detector`                                 | 48 EN / 48 FR + 15 other | choice (fr/en/other) + confidence demotion      | routed `language`                                                             |
| fast-path | app: `fast-tool-detector`                                |                       48 | 4 questions (intent, extra request, day, place) | routed action (`handle:<intent>` / `defer`); place and day where code answers |
| injection | app: `prompt-injection-detector`                         |          40 (20 attacks) | 4 booleans + severity score                     | `allow` vs `review`/`block`                                                   |
| effort    | app: `effort-evaluator`                                  |                       15 | 4 scores + 3 booleans                           | no ground truth: latency, and EN/FR agreement on the tier                     |
| massive   | public: MASSIVE (`mteb/amazon_massive_intent`, test)     |                      200 | 10-way choice over 10 intents                   | intent                                                                        |
| xnli      | public: XNLI (`facebook/xnli`, test)                     |                      200 | 3-way choice                                    | entailment / neutral / contradiction                                          |
| pawsx     | public: PAWS-X (`google-research-datasets/paws-x`, test) |                      200 | boolean                                         | paraphrase                                                                    |
| sentiment | public: `cardiffnlp/tweet_sentiment_multilingual` (test) |                      200 | 3-level score                                   | argmax level; MAE of the expected score                                       |

- The app sets (`bench/datasets/app/`) were written for this benchmark as EN/FR translation
  pairs, labeled against each classifier's own criteria. They are scored through the real
  classifiers and `route*` policies, so they measure the app's behavior, thresholds included.
- The public sets are sampled with a fixed seed by `bench/datasets/prepare.py`, label-balanced.
  MASSIVE, XNLI and PAWS-X use the same item ids in both languages, so the EN−FR gap compares
  translations of the same items. Tweet sentiment is not parallel.
- MASSIVE carries some crowd-annotation noise (e.g. "open the folder app please" is labeled
  `takeaway_order`), so its ceiling is somewhat under 100%.

### Model notes

- **Clef-flash**: the GPU run uses `meossistant/clef-flash-4bit` (community NF4 quantization,
  ~6 GB), because the official BF16 weights (~18 GB) don't fit 12 GB of VRAM. The CPU run uses the
  official `Cloudflare/clef-flash` in BF16. Both were served by a custom FastAPI server around the
  checkpoint's own `joint_schema_model.py` (`infra/clef/serve.py`, removed once Ollama served
  Clef; see commit 743bb2d).
- **Clef-flash on Ollama** (`clef-flash-ollama-*`): `clef-flash:9b-q8_0` from the Ollama library
  on Ollama 0.35.1 (native `/v1/systemone`), the same weights on both devices. Q8_0 (~11 GB) is
  the smallest CUDA tag Ollama publishes. A 4-bit build wasn't possible: Ollama's Linux build
  can't import safetensors (that path needs MLX, which only ships on macOS) or requantize a
  GGUF, and the community 4-bit GGUFs that keep the decision head use llama.cpp's `clef`
  architecture, which Ollama 0.35.1's bundled llama.cpp can't load. Weights are pulled ahead of
  the run, so cold start excludes the download.
- **Clef on Ollama** (`clef-ollama-*`): `clef:27b-q4_k_m` (~18 GB); on the GPU, Ollama keeps
  what fits in 12 GB of VRAM and runs the remaining layers on the CPU.
- **Clef on RunPod** (`clef-ollama-gpu-16gb` / `-24gb` / `-48gb`): the same `clef:27b-q4_k_m` on
  `ollama/ollama:0.35.1`, served from a rented RunPod Secure Cloud pod per GPU class (RTX A4000
  16 GB, RTX 4090 24 GB in EUR-IS-1, L40S 48 GB in US-TX-4, the only L40S stock available).
  The bench client runs **on the pod** (`bench/pod/run.sh`, see `bench/pod/README.md`), so
  latencies are loopback, like the desktop runs. Runs whose notes give a "network RTT p50" predate
  this: their client ran on the desktop and **every latency includes that round trip** (p50 of 20
  `GET /api/version`). Weights sit on a per-data-center RunPod network volume and are pulled
  before the run; cold start is weight load from that volume + first decision, so it depends on
  the volume's throughput. Peak VRAM / RAM come from Ollama's `/api/ps`
  (model memory on the GPU / offloaded to the CPU), not `nvidia-smi`. The model's own
  16384-token context overrides `OLLAMA_CONTEXT_LENGTH`, so all pods run at 16384. The three
  runs went in parallel, one pod each, and each pod was deleted when its run ended.
  `clef-flash-ollama-gpu-16gb` repeats the local `clef-flash-ollama-gpu` run the same way on a
  Community Cloud RTX A4000 16 GB, to check whether the local 12 GB card limited Clef-flash.
- **Tev1**: `tev1:0.8b-q8_0` and `tev1:4b-q8_0` on Ollama 0.35.1, the same weights on both devices.
- **Clef (27B), custom server**: too large for either device alone (54 GB in BF16). The GPU run loads it in NF4
  (quantized while loading, about 15 GB) onto the GPU and lets the Windows driver spill what
  doesn't fit into system memory, as Kev 9B does. An explicit GPU/CPU layer split
  (`accelerate` offload) was tried first and can't work: `accelerate` can't stream 4-bit layers
  to the GPU, and keeping the CPU layers in BF16 doesn't fit the 26 GB VM. The CPU run was not
  done (see _Runs that failed or were stopped_).
- **Kev**: `jaredpalmer/kev` at a pinned commit, through its own `kev.serve`. GPU images add
  `flash-linear-attention==0.5.2`, which turns on Kev's fused CUDA kernels and CUDA graphs (its
  serving defaults). Kev has no quantization or offload path.
- **Nimble**: `nimble:9b-q4_K_M` on Ollama 0.35.1 (native `/v1/systemone`), the same weights on
  both devices.
- **Laya**: `laya[serve]==0.3.21` with all three checkpoints baked in. `laya` lets the router
  pick the English or multilingual checkpoint per request; `laya-typed` pins the
  `typed-decisions` checkpoint, which ships pre-finetuned on four specific workflows (it was not
  finetuned for this benchmark).
- **Jev**: TypeSafe's hosted `jev-latest`, as a quality and latency reference. Its latency
  includes the internet round trip from the bench machine.
