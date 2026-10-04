"""Downloads Kev checkpoints and the exact Qwen3.5 base snapshot each one pins into $HF_HOME,
so `kev.serve` can start offline.

Usage: python -m kev_fetch jaredpalmer/kev-4b [jaredpalmer/kev-9b ...]
"""

import os
import sys

os.environ["HF_HUB_OFFLINE"] = "0"
os.environ["TRANSFORMERS_OFFLINE"] = "0"

from huggingface_hub import snapshot_download  # noqa: E402
from kev.checkpoint import Checkpoint  # noqa: E402

for run in sys.argv[1:]:
    checkpoint = Checkpoint(run)
    meta = checkpoint.meta
    print(f"{run}: {checkpoint.path}", flush=True)
    base = snapshot_download(meta.base, revision=meta.base_revision)
    print(f"  base {meta.base}@{meta.base_revision}: {base}", flush=True)
