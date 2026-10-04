"""Downloads Hugging Face repos into $HF_HOME, so the server itself can start offline.

Usage: python -m clef_fetch <repo> [<repo> ...]
"""

import os
import sys

os.environ["HF_HUB_OFFLINE"] = "0"

from huggingface_hub import snapshot_download  # noqa: E402

for repo in sys.argv[1:]:
    print(snapshot_download(repo), flush=True)
