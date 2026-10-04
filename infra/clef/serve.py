"""clef-serve: a Jev-compatible /v1/systemone endpoint for Cloudflare's Clef decision models.

Wraps the `joint_schema_model.py` that ships inside each Clef checkpoint (record encoding, the
joint schema head, answer formatting), so requests are encoded exactly as the release does.
Configuration is environment-only:

=====================  ===========================================================  ==============
env var                meaning                                                      default
=====================  ===========================================================  ==============
CLEF_MODEL             Hub id or local path of a Clef checkpoint                    Cloudflare/clef-flash
CLEF_MODEL_NAME        model id reported by /v1/models and echoed in responses      basename of CLEF_MODEL
CLEF_DEVICE            cuda | cpu                                                   cuda if available
CLEF_QUANT             none | nf4 (bitsandbytes 4-bit, quantized while loading)     none
CLEF_MAX_GPU_MEM       e.g. 10GiB: split BF16 weights across GPU and CPU            (unset = one device)
CLEF_MAX_CPU_MEM       CPU share of that split                                      20GiB
CLEF_THREADS           torch intra-op threads for CPU inference                     torch default
CLEF_MAX_LENGTH        token cap per request (state is truncated to fit)            16384
CLEF_API_KEY           if set, require Authorization: Bearer <key>                  (none)
CLEF_HOST / CLEF_PORT  bind address                                                 0.0.0.0 / 8000
=====================  ===========================================================  ==============

A pre-quantized checkpoint (e.g. meossistant/clef-flash-4bit) carries its own quantization
config: leave CLEF_QUANT=none for it.
"""

import hmac
import importlib.util
import json
import logging
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any

import torch
from fastapi import FastAPI, Header, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

log = logging.getLogger("clef.serve")

MODEL = os.environ.get("CLEF_MODEL", "Cloudflare/clef-flash").strip()
MODEL_NAME = os.environ.get("CLEF_MODEL_NAME", "").strip() or MODEL.rstrip("/").split("/")[-1]
DEVICE = os.environ.get("CLEF_DEVICE", "").strip() or ("cuda" if torch.cuda.is_available() else "cpu")
QUANT = os.environ.get("CLEF_QUANT", "none").strip().lower()
MAX_GPU_MEM = os.environ.get("CLEF_MAX_GPU_MEM", "").strip()
MAX_CPU_MEM = os.environ.get("CLEF_MAX_CPU_MEM", "20GiB").strip()
MAX_LENGTH = int(os.environ.get("CLEF_MAX_LENGTH", "16384"))
API_KEY = os.environ.get("CLEF_API_KEY", "").strip()


def _import_release_module(path: Path) -> Any:
    """Imports the checkpoint's own joint_schema_model.py, so encoding matches the release."""
    spec = importlib.util.spec_from_file_location("joint_schema_model", path / "joint_schema_model.py")
    if spec is None or spec.loader is None:
        raise RuntimeError(f"{path} has no joint_schema_model.py")
    module = importlib.util.module_from_spec(spec)
    # dataclasses resolves annotations through sys.modules, so register before executing.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _quantization_config() -> Any:
    from transformers import BitsAndBytesConfig

    return BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype=torch.bfloat16,
    )


def load(path: Path, jsm: Any) -> tuple[Any, Any]:
    """Loads backbone + head. Single-device loads go through the release's own loader."""
    if not MAX_GPU_MEM:
        kwargs = {"quantization_config": _quantization_config()} if QUANT == "nf4" else {}
        return jsm.load_release_model(path, device=DEVICE, dtype=torch.bfloat16, **kwargs)

    # GPU+CPU split: the release loader pins one device, so this mirrors it with a device_map.
    # Only for unquantized weights: accelerate streams CPU-placed layers to the GPU on each
    # forward, and it can't move bitsandbytes 4-bit tensors (their quant_state stays on the meta
    # device, so loading or the first forward fails).
    if QUANT == "nf4":
        raise RuntimeError(
            "CLEF_MAX_GPU_MEM can't be combined with CLEF_QUANT=nf4; unset CLEF_MAX_GPU_MEM to load "
            "the 4-bit model on the GPU (the driver may spill what doesn't fit to system memory)"
        )
    from safetensors.torch import load_file
    from transformers import AutoProcessor, Qwen3_5ForConditionalGeneration

    backbone = Qwen3_5ForConditionalGeneration.from_pretrained(
        path,
        dtype=torch.bfloat16,
        device_map="auto",
        max_memory={0: MAX_GPU_MEM, "cpu": MAX_CPU_MEM},
    )
    backbone.config.use_cache = False
    head = jsm.JointSchemaHead(**json.loads((path / "joint_head_config.json").read_text()))
    head.load_state_dict(load_file(path / "joint_head.safetensors"), strict=True)
    # The head reads the output embeddings, so it lives wherever those landed.
    head_device = backbone.get_output_embeddings().weight.device
    head = head.to(device=head_device, dtype=torch.bfloat16)
    return jsm.ClefModel(backbone, head).eval(), AutoProcessor.from_pretrained(path)


def make_forward(jsm: Any) -> Any:
    """ClefModel.forward, but moving the backbone output onto the head's device first, which a
    GPU+CPU split needs and a single-device load doesn't notice."""

    def forward(model: Any, batch: dict[str, Any]) -> list[list[torch.Tensor]]:
        base = model.language_model
        text_model = base.model.language_model if hasattr(base.model, "language_model") else base.model
        outputs = text_model(
            input_ids=batch["input_ids"],
            attention_mask=batch["attention_mask"],
            use_cache=False,
            return_dict=True,
        )
        embedding = base.get_output_embeddings().weight
        device = next(model.head.parameters()).device
        return model.head(
            outputs.last_hidden_state.to(device),
            batch["input_ids"].to(device),
            batch["attention_mask"].to(device),
            batch["records"],
            embedding.to(device) if embedding.device != device else embedding,
        )

    return forward


def validate(body: Any) -> None:
    if not isinstance(body, dict) or "state" not in body:
        raise ValueError("state is required")
    questions = body.get("questions")
    if not isinstance(questions, dict) or not questions:
        raise ValueError("at least one question is required")
    for question_id, question in questions.items():
        if not isinstance(question, dict) or question.get("type") not in ("noul", "choice", "score"):
            raise ValueError(f"{question_id}: type must be noul, choice, or score")
        if question["type"] != "noul" and not question.get("criteria"):
            raise ValueError(f"{question_id}: criteria must not be empty")


def create_app() -> FastAPI:
    from huggingface_hub import snapshot_download

    if threads := os.environ.get("CLEF_THREADS", "").strip():
        torch.set_num_threads(int(threads))

    started = time.time()
    path = Path(MODEL) if Path(MODEL).is_dir() else Path(snapshot_download(MODEL))
    jsm = _import_release_module(path)
    model, processor = load(path, jsm)
    forward = make_forward(jsm)
    input_device = next(model.language_model.parameters()).device
    load_seconds = round(time.time() - started, 1)
    log.warning("loaded %s on %s (quant=%s, split=%s) in %ss", MODEL, DEVICE, QUANT, MAX_GPU_MEM or "no", load_seconds)

    lock = threading.Lock()
    app = FastAPI(title="clef-serve")

    @torch.inference_mode()
    def answer(body: dict[str, Any]) -> dict[str, Any]:
        encoded = jsm.encode_record(processor.tokenizer, body, max_length=MAX_LENGTH)
        batch = jsm.collate_records([encoded], processor.tokenizer.pad_token_id, input_device)
        with lock:
            logits = forward(model, batch)[0]
        questions = body["questions"]
        answers = {
            question.question_id: jsm.systemone_answer(
                questions[question.question_id],
                dict(zip(question.option_ids, question_logits.float().softmax(-1).tolist())),
            )
            for question, question_logits in zip(encoded.questions, logits)
        }
        return {
            "model": MODEL_NAME,
            "answers": answers,
            "usage": {"input_tokens": len(encoded.input_ids), "output_tokens": 0},
        }

    def check_auth(authorization: str | None) -> None:
        if API_KEY and not hmac.compare_digest(authorization or "", f"Bearer {API_KEY}"):
            raise HTTPException(401, "invalid or missing API key")

    @app.get("/health")
    def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "model": MODEL_NAME,
            "device": DEVICE,
            "quant": QUANT,
            "split": MAX_GPU_MEM or None,
            "load_seconds": load_seconds,
        }

    @app.get("/v1/models")
    def models(authorization: str | None = Header(default=None)) -> dict[str, Any]:
        check_auth(authorization)
        return {"object": "list", "data": [{"id": MODEL_NAME, "object": "model", "owned_by": "cloudflare"}]}

    @app.post("/v1/systemone")
    async def systemone(body: dict[str, Any], authorization: str | None = Header(default=None)) -> Any:
        check_auth(authorization)
        try:
            validate(body)
            return await run_in_threadpool(answer, body)
        except ValueError as error:
            return JSONResponse({"error": {"message": str(error)}}, status_code=400)
        except torch.OutOfMemoryError:
            log.exception("out of memory")
            return JSONResponse({"error": {"message": "out of memory"}}, status_code=507)

    return app


def main() -> None:
    import uvicorn

    host = os.environ.get("CLEF_HOST", "0.0.0.0")
    port = int(os.environ.get("CLEF_PORT", "8000"))
    uvicorn.run(create_app(), host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
