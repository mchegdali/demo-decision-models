# syntax=docker/dockerfile:1.7
# kev-serve: Jared Palmer's Kev decision models (https://github.com/jaredpalmer/kev) behind their
# own TypeSafe-compatible /v1/systemone server. Weights (Qwen3.5 base + LoRA adapter + head) are
# mounted at /models/hf; fill the volume once with `python -m kev_fetch <kev repo>`.
# CPU by default; build with TORCH_INDEX=cu128 for NVIDIA GPUs.

ARG PYTHON_VERSION=3.12

FROM python:${PYTHON_VERSION}-slim AS builder

ARG TORCH_INDEX=cpu
ARG KEV_COMMIT=84847f0a883d900f7de5b7a57eaa341ca7f9a6b4
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH

# kev pins torch>=2.6,<2.9; install it from the chosen index first so pip doesn't pull CUDA into
# the CPU image. kev.serve turns on its fused Qwen3.5 kernels on CUDA only with exactly
# flash-linear-attention 0.5.2 (kev/fused_qwen35.py).
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --index-url https://download.pytorch.org/whl/${TORCH_INDEX} "torch>=2.6,<2.9" \
 && pip install "kev[serve] @ git+https://github.com/jaredpalmer/kev.git@${KEV_COMMIT}" \
 && if [ "${TORCH_INDEX}" != "cpu" ]; then pip install "flash-linear-attention==0.5.2"; fi

RUN find /opt/venv \( -type d \( -name __pycache__ -o -name tests -o -name test \) \) -prune -exec rm -rf {} + \
 && find /opt/venv -name '*.pyc' -delete

FROM python:${PYTHON_VERSION}-slim AS runtime

ARG TORCH_INDEX=cpu
# Triton (behind flash-linear-attention) compiles a small C helper the first time it runs on
# CUDA, so GPU images need a C compiler at runtime. CPU images never load Triton.
RUN if [ "${TORCH_INDEX}" != "cpu" ]; then \
      apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev \
      && rm -rf /var/lib/apt/lists/*; \
    fi

RUN groupadd --system --gid 10001 kev \
 && useradd --system --uid 10001 --gid kev --no-create-home --home-dir /nonexistent kev

COPY --from=builder /opt/venv /opt/venv
COPY kev_fetch.py /app/kev_fetch.py

ENV PATH=/opt/venv/bin:$PATH \
    PYTHONPATH=/app \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HF_HOME=/models/hf \
    HF_HUB_OFFLINE=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    TRANSFORMERS_OFFLINE=1 \
    TRITON_CACHE_DIR=/tmp/triton \
    KEV_RUN=jaredpalmer/kev-4b

USER kev
WORKDIR /app
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=600s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/v1/models', timeout=4)"]

CMD ["sh", "-c", "exec python -m kev.serve --run \"$KEV_RUN\" --host 0.0.0.0 --port 8000"]
