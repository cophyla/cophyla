"""Fetches Chatterbox Turbo's weights into the sidecar's own Hugging Face cache, at a pinned
revision, printing `progress <fraction>` lines the daemon turns into `voice.setup`. The
repository and the file patterns are the engine's own, so the server that starts afterwards
under `HF_HUB_OFFLINE=1` finds everything it asks for already there.

    python fetch_weights.py --revision main

Run once by the daemon during the bootstrap, with `HF_HOME` pointing inside
`~/.cophyla/data/sidecars/tts-py/`. Afterwards the server runs with `HF_HUB_OFFLINE=1`: the
sidecar never reaches the network again.
"""

import argparse
import sys
import threading
import time

from huggingface_hub import snapshot_download

# What `chatterbox.tts_turbo` itself downloads: the same repository and the same subset, so
# the run afterwards finds every file in the cache and never reaches the network.
REPO = "ResembleAI/chatterbox-turbo"
PATTERNS = ["*.safetensors", "*.json", "*.txt", "*.pt", "*.model"]

parser = argparse.ArgumentParser()
parser.add_argument("--revision", default="main")
parser.add_argument("--repo", default=REPO)
args = parser.parse_args()


def report(done: threading.Event) -> None:
    """A coarse heartbeat: the hub gives no total, so this says something is still moving."""
    started = time.time()
    while not done.wait(2.0):
        # Approaches 1 without reaching it; the caller takes `ready` as the end, not this.
        elapsed = time.time() - started
        print(f"progress {min(0.95, elapsed / (elapsed + 120)):.2f}", flush=True)


done = threading.Event()
thread = threading.Thread(target=report, args=(done,), daemon=True)
thread.start()
try:
    path = snapshot_download(repo_id=args.repo, revision=args.revision, allow_patterns=PATTERNS)
finally:
    done.set()
print("progress 1.0", flush=True)
print(f"weights at {path}", flush=True)
sys.exit(0)
