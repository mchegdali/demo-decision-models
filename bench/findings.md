## Findings

### Recommendation

- **Clef-flash (9B, 4-bit) on a 12 GB GPU is the best self-hosted option.** It has a p50 of
  148 ms and a p95 of 322 ms over every request, and needs 8.1 GiB of VRAM. Its accuracy
  (88.2 EN / 84.8 FR) is level with hosted Jev (87.4 / 85.9), and it is the best model on the
  app's own classifiers: fast-path 100 / 100, injection 97.5 / 97.5, language 100 / 97.9 with
  every "other" input right. Its weak spots are tweet sentiment (59.5 / 46.0) and PAWS-X
  (78 / 77).
- **Nimble 9B (q4_K_M on Ollama) on the same GPU is the most accurate overall** (88.9 / 87.0,
  1.9-point EN−FR gap) and also passes (p50 346 ms, p95 1024 ms). But it runs one pass per
  question, so a 7-question effort request takes 1.6 s against Clef-flash's 0.4 s.
- **No model is both accurate and fast on this CPU.** The only CPU runs that pass the slowness
  rule are Laya and Laya typed-decisions, which are about 25 points less accurate and can't
  detect the language (below). Kev 0.8B on CPU has a p50 of 672 ms but fails on p95 (2.3 s).
  Every 4B+ model takes several seconds per request on the CPU.

So "at the edge" here means a consumer GPU: one 12 GB card runs a Jev-level decision model at
interactive speed. CPU-only machines get speed or accuracy, not both.

### Device doesn't change answers

Every model that ran on both devices scores within about a point on every task. The device only
changes latency, memory and cold start, so a CPU deployment can be judged on speed alone.

### Model by model

- **Clef-flash**: the GPU run uses a community NF4 quantization (`meossistant/clef-flash-4bit`)
  and still matches Jev, so 4-bit doesn't seem to cost it accuracy. It is also the best calibrated
  (ECE 0.047). Its latency grows slowly with questions (2.5× from 1 to 7). The CPU run used the
  official BF16 weights, which this CPU has no instructions for: it took about 75 s per request,
  was projected at 37+ hours, and was stopped after 150 items.
- **Clef (27B)**: not measured on this machine. An explicit GPU/CPU layer split can't work here: `accelerate` can't stream 4-bit layers to the GPU, and keeping the CPU half in BF16 doesn't fit the 26 GB VM. Loading all of it in NF4 on the GPU (about 15 GB, with the overflow spilled to system memory) ran the 32 GB host out of RAM while the weights were being quantized.
  On rented RunPod GPUs (Ollama `clef:27b-q4_k_m`), it needs **24 GB**: it takes 20.4 GB, all
  on the GPU. On a 16 GB RTX A4000 it never loaded (out of memory for the compute buffer; see
  the failed runs). On an RTX 4090 it scores 89.2 EN / 85.3 FR, the best of any open model here,
  at p50 460 ms / p95 720 ms, including an 87 ms network round trip. Most of its gain over
  Clef-flash is PAWS-X (87.5 / 86.5 against 78 / 77); elsewhere the two are within about two
  points. A 48 GB L40S gives the same answers and no speed-up; it was slower here only because
  it sat in Texas (231 ms round trip).
- **Clef-flash wasn't limited by the local GPU.** It already ran fully on the RTX 4070 (33/33
  layers, 16384-token context). The same `clef-flash:9b-q8_0` on a rented 16 GB A4000 scores the
  same (87.6 / 84.5) and is slower (p50 716 ms with a 74 ms round trip), because the A4000 is not
  a faster card than the 4070 and every request crosses the network.
- **Nimble 9B**: the smallest EN−FR gap with Jev, and perfect fast-path in both languages. On the
  CPU it is accurate but takes 5.6 s p50 and 19 s p95 (14.4 GiB RAM).
- **Kev 4B and 9B**: close to Jev on accuracy (86.5–86.8 EN; 9B has a 2.3-point FR gap), but
  this 12 GB card is too small for them in BF16, and Kev has no quantization or offload. The 4B
  peaks at 11.9 GB of VRAM. Its one-question requests take about 0.27 s, but multi-question ones
  take 5–10 s, and its scaling probe is erratic (2 questions slower than 4). That pattern fits
  memory spilling into shared system memory. The 9B (about 18 GB of weights) loads only because
  Windows lets the GPU use system memory, and it's slow everywhere (p50 1.06 s, 6 min cold
  start). Expect both to need a 24 GB GPU. Kev 4B on the CPU runs in fp32: p50 3.9 s, 17.9 GiB
  RAM. Kev 9B on CPU was not run (BF16, same problem as Clef-flash).
- **Kev 0.8B**: the fastest model by far on GPU (13 ms p50, 77 decisions/s) and good on MASSIVE
  (95 / 93), but weak in French (16-point mean gap). It never detects French: all 48 French
  prompts route to `other` or `en`, with a mean P(fr) of 0.13.
- **Laya** (router across its English and multilingual checkpoints): 47 ms p50 on GPU, 265 ms on
  CPU, 18–26 s cold start, but 63.7 / 59.4 accuracy. The language detector is unusable with it:
  it answers "other" for 47 of 48 English prompts (and "fr" for the last one), and gets 39.6% of French. Fast-path place
  extraction is under 20%.
- **Laya typed-decisions**: answers "other" for every language-detection input (0% EN and FR)
  and has the lowest fast-path accuracy (43.8). This checkpoint ships finetuned for four specific
  workflows, so it doesn't carry over to these zero-shot questions.
- **Jev (hosted)**: the reference. 221 ms p50 over the internet, flat with question count
  (1.1× from 1 to 7), with the smallest EN−FR gap (1.5 points).

### French

The strong models (Jev, Nimble, Clef-flash, Kev 9B) lose 1.5–3.4 points from English to French
on average. Small models lose much more (Kev 0.8B 16, Laya typed 8.5). Sentiment is the weakest
French task for every model. Its tweets aren't translations of the English ones, so part of that
gap comes from the dataset itself.

### Cold start

Laya is ready in 18–26 s, Clef-flash in 57 s, Nimble in 76 s, Kev 0.8B in 91 s, Kev 4B in
151 s and Kev 9B in 354 s (weights already on disk). Only Laya restarts fast enough to
scale to zero.
