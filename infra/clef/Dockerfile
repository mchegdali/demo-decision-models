# syntax=docker/dockerfile:1.7
# clef-serve: a Jev-compatible /v1/systemone endpoint for Cloudflare's Clef decision models
# (https://huggingface.co/Cloudflare/clef-flash, https://huggingface.co/Cloudflare/clef).
# Weights are too large to bake in (18 GB / 54 GB): mount a volume at /models/hf and fill it once
# with `python -m clef_fetch <repo>` (see bench/containers.ps1). CPU by default; build with
# TORCH_INDEX=cu128 for NVIDIA GPUs.

ARG PYTHON_VERSION=3.12

FROM python:${PYTHON_VERSION}-slim AS builder

ARG TORCH_INDEX=cpu
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH

# Versions from the Clef model card ("tested with torch 2.11 and transformers 5.10.2"). GPU images
# also get flash-linear-attention: Triton kernels for Qwen3.5's gated-DeltaNet layers, which
# transformers otherwise runs in slow pure torch.
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --index-url https://download.pytorch.org/whl/${TORCH_INDEX} "torch==2.11.*" torchvision \
 && pip install "transformers==5.10.2" accelerate bitsandbytes safetensors huggingface_hub \
      pillow fastapi "uvicorn[standard]" \
 && if [ "${TORCH_INDEX}" != "cpu" ]; then pip install flash-linear-attention; fi

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

RUN groupadd --system --gid 10001 clef \
 && useradd --system --uid 10001 --gid clef --no-create-home --home-dir /nonexistent clef

COPY --from=builder /opt/venv /opt/venv
COPY serve.py /app/serve.py
COPY clef_fetch.py /app/clef_fetch.py

ENV PATH=/opt/venv/bin:$PATH \
    PYTHONPATH=/app \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HF_HOME=/models/hf \
    HF_HUB_OFFLINE=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    TRANSFORMERS_OFFLINE=1 \
    TRITON_CACHE_DIR=/tmp/triton \
    CLEF_HOST=0.0.0.0 \
    CLEF_PORT=8000

USER clef
WORKDIR /app
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=600s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"]

CMD ["python", "/app/serve.py"]
