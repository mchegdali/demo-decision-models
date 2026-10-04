# syntax=docker/dockerfile:1.7
# laya-serve: a Jev-compatible /v1/systemone endpoint backed by
# https://huggingface.co/convaiinnovations/laya, with weights baked in so it starts offline.
# CPU-only by default; build with TORCH_INDEX=cu128 and LAYA_DEVICE=cuda for a GPU image.

ARG PYTHON_VERSION=3.12

# --- builder: virtualenv with torch + laya[serve] ----------------------------------------------
FROM python:${PYTHON_VERSION}-slim AS builder

ARG LAYA_VERSION=0.3.21
# PyTorch wheel index: `cpu` keeps CUDA libs out of the image; `cu128` for NVIDIA GPUs.
ARG TORCH_INDEX=cpu
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH

# torch first so laya's `torch>=2.0.0` is already satisfied from the chosen index.
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --index-url https://download.pytorch.org/whl/${TORCH_INDEX} torch \
 && pip install "laya[serve]==${LAYA_VERSION}"

# Test suites and bytecode caches are dead weight at runtime.
RUN find /opt/venv \( -type d \( -name __pycache__ -o -name tests -o -name test \) \) -prune -exec rm -rf {} + \
 && find /opt/venv -name '*.pyc' -delete

# --- weights: let the Router fetch exactly the files it loads ---------------------------------
FROM builder AS weights

# english + multilingual are what the Router auto-selects between; typed-decisions is opt-in.
ARG LAYA_MODELS=english,multilingual
# "reviewed" pins each checkpoint to the SHA laya ships in laya.revisions.PINNED_REVISIONS.
ARG LAYA_REVISION=reviewed
ENV HF_HOME=/models/hf \
    HF_HUB_DISABLE_TELEMETRY=1 \
    LAYA_REVISION=${LAYA_REVISION}

RUN python -c "import os; from laya.router import Router; Router(device='cpu').preload(os.environ['LAYA_MODELS'].split(','))" \
 && rm -rf /models/hf/xet /models/hf/hub/.locks

# --- runtime -----------------------------------------------------------------------------------
FROM python:${PYTHON_VERSION}-slim AS runtime

ARG LAYA_MODELS=english,multilingual
ARG LAYA_REVISION=reviewed
ARG LAYA_DEVICE=cpu

RUN groupadd --system --gid 10001 laya \
 && useradd --system --uid 10001 --gid laya --no-create-home --home-dir /nonexistent laya

COPY --from=builder /opt/venv /opt/venv
COPY --from=weights --chown=laya:laya /models/hf /models/hf

ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HF_HOME=/models/hf \
    HF_HUB_OFFLINE=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    TRANSFORMERS_OFFLINE=1 \
    LAYA_DEVICE=${LAYA_DEVICE} \
    LAYA_PRELOAD=1 \
    LAYA_MODELS=${LAYA_MODELS} \
    LAYA_REVISION=${LAYA_REVISION} \
    LAYA_HOST=0.0.0.0 \
    LAYA_PORT=8000

USER laya
EXPOSE 8000

# slim ships neither curl nor wget; the venv's python is always there.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"]

CMD ["laya-serve"]
