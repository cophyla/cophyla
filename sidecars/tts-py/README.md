# tts-py

Chatterbox Turbo behind an OpenAI-shaped speech endpoint on loopback: the GPU engine for the
`tts` stage. Kokoro is the default and runs in the daemon itself; this exists for a machine
with a GPU and a voice worth cloning.

The platform ships these sources and the locked requirements and nothing else. The Python
environment (about 5 GB) and the weights (about 2 GB) are built by the daemon the first time
the stage is turned on, under `~/.cophyla/data/sidecars/tts-py/`, and every step of it reaches
the user as `voice.setup`. The installer never does this work, and neither does a release.

## The endpoint

| | |
|---|---|
| `GET /health` | `{ok, device, voice, sr, loadSeconds}` once the model is loaded and warm; nothing before, so the supervisor's first pass is the real one |
| `POST /v1/audio/speech` | `{input, response_format: "pcm" \| "wav", voice?}` — `pcm` streams int16 little-endian mono, one chunk per sentence, with the rate in `X-Sample-Rate` |

Sentence-at-a-time is what makes the first words leave in about a second: `generate()` is not
streaming, so a long reply would otherwise be silent until all of it existed.

## Running it by hand

```
uv venv --python 3.11 .venv
uv pip install --python .venv/Scripts/python.exe -r requirements-windows-x64.lock --index-strategy unsafe-best-match
.venv/Scripts/python server.py --port 8321 --device cuda --voice C:\clips\me.wav --affinity 0-15
```

| Flag | What it does |
|---|---|
| `--port` | the port the daemon chose; there is no default worth relying on |
| `--host` | loopback, and it refuses anything else without `--allow-lan` |
| `--device` | `auto` (CUDA when there is one), `cuda`, `cpu` |
| `--voice` | the reference clip the voice is cloned from; required, and Chatterbox asserts it is longer than five seconds |
| `--affinity` | `0-15` or `0-7,16`: the logical CPUs to run on |
| `--warm` | the line spoken once at startup to compile the kernels |

## What the daemon does

`apps/cophylad/src/sidecars/tts-py.ts` runs four steps, each with a marker file so an
interrupted bootstrap resumes rather than starting again: fetch a pinned `uv`, make the
environment, install the lock for this target, fetch the weights at a pinned revision. Then
`apps/cophylad/src/sidecars/index.ts` spawns `server.py` on a free loopback port, polls
`/health`, restarts it with backoff if it dies, hands it the daemon's own CPU mask, and kills
it when the daemon stops. `HF_HUB_OFFLINE=1` is set for the run: once the weights are there,
the sidecar never reaches the network.

## The locks

One per target, compiled with hashes from `pyproject.toml`:

```
uv pip compile pyproject.toml --generate-hashes --python-version 3.11 \
  --index https://download.pytorch.org/whl/cu124 --index-strategy unsafe-best-match \
  -o requirements-windows-x64.lock
uv pip compile pyproject.toml --generate-hashes --python-version 3.11 \
  --python-platform x86_64-unknown-linux-gnu --index https://download.pytorch.org/whl/cu124 \
  --index-strategy unsafe-best-match -o requirements-linux-x64.lock
uv pip compile pyproject.toml --generate-hashes --python-version 3.11 \
  --python-platform aarch64-apple-darwin -o requirements-macos-arm64.lock
```

Windows and Linux take `torch==2.6.0+cu124` from the CUDA index; macOS takes the default
wheels, where the engine runs on the CPU and is slower than real time — Kokoro is the better
answer there. `setuptools` is held under 81 because the dependency chain still imports
`pkg_resources`.

## Measured

Spike 10, on an RTX 4080 with the process pinned to the performance cores: 8.8 s to load,
2.7 GB of VRAM after loading and 3.7 GB at the peak of a 25 s paragraph, 0.9 s for a short
line (real-time factor 0.26–0.29), 0.55 s to the first sentence of a paragraph. Unpinned, the
token loop lands on the efficiency cores and takes three times as long. On the CPU a short
line takes 5.3 s for 3 s of audio.
