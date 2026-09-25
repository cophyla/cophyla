"""The speech sidecar: Chatterbox Turbo behind an OpenAI-shaped endpoint on loopback,
streaming raw PCM one sentence at a time so the first words leave before the rest is
synthesised.

The daemon spawns this with a port it chose and takes it down with itself; it is never run
by an installer and never reached from off the machine. See `apps/cophylad/src/sidecars/`.

    python server.py --port 8321 --device cuda --voice C:\\clips\\me.wav --affinity 0-15

  GET  /health            -> {"ok": true, ...} once the model is loaded and warm; 503 before
  POST /v1/audio/speech   {"input": text, "response_format": "pcm" | "wav", "voice"?: path}
                          pcm: int16 little-endian mono at the model's rate, one chunk per
                          sentence, with the rate in `X-Sample-Rate`
"""

import argparse
import re
import struct
import sys
import threading
import time

import numpy as np
import torch
import uvicorn
from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=8321)
parser.add_argument("--host", default="127.0.0.1", help="loopback unless --allow-lan says otherwise")
parser.add_argument("--allow-lan", action="store_true", help="bind off loopback; the daemon never asks for this")
parser.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
parser.add_argument("--voice", required=True, help="the reference clip the voice is cloned from; longer than 5 s, or Chatterbox refuses it")
parser.add_argument("--affinity", default="", help="logical CPUs to run on, e.g. 0-15 or 0-7,16: on a hybrid CPU the token loop is launch-bound and three times slower on the efficiency cores")
parser.add_argument("--warm", default="Ready.", help="the line spoken once at startup to compile the kernels")
args = parser.parse_args()

if args.host != "127.0.0.1" and not args.allow_lan:
    print(f"refusing to bind {args.host}: pass --allow-lan if that is really meant", file=sys.stderr, flush=True)
    raise SystemExit(2)


def cpus(spec: str) -> list[int]:
    """`0-15`, `0,2,4` or a mix, as a list of logical CPUs."""
    out: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            lo, hi = (int(x) for x in part.split("-", 1))
            out.extend(range(lo, hi + 1))
        else:
            out.append(int(part))
    return out


if args.affinity:
    import psutil

    wanted = cpus(args.affinity)
    if wanted:
        psutil.Process().cpu_affinity(wanted)
        print(f"pinned to {len(wanted)} logical CPUs ({args.affinity})", flush=True)

device = args.device
if device == "auto":
    device = "cuda" if torch.cuda.is_available() else "cpu"

t0 = time.perf_counter()
from chatterbox.tts_turbo import ChatterboxTurboTTS  # noqa: E402

model = ChatterboxTurboTTS.from_pretrained(device=device)
model.prepare_conditionals(args.voice)
# The first generation compiles the kernels: doing it here means the first request is not the slow one.
if args.warm:
    model.generate(args.warm)
ready_at = time.perf_counter()
print(f"tts-py ready on {args.host}:{args.port} in {ready_at - t0:.1f} s ({device}, voice {args.voice})", flush=True)

lock = threading.Lock()  # one synthesis at a time: the GPU is shared with whatever else runs
app = FastAPI()


class Speech(BaseModel):
    input: str
    response_format: str = "pcm"
    voice: str | None = None
    model: str | None = None


def sentences(text: str) -> list[str]:
    parts = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]
    return parts or [text]


def synth(text: str) -> np.ndarray:
    t = time.perf_counter()
    with lock:
        wav = model.generate(text)
    took = time.perf_counter() - t
    print(f"  synth {len(text)} chars -> {wav.shape[-1] / model.sr:.2f} s audio in {took:.2f} s", flush=True)
    return (wav.squeeze(0).numpy() * 32767).clip(-32768, 32767).astype("<i2")


def wav_header(n_samples: int, sr: int) -> bytes:
    data = n_samples * 2
    return b"RIFF" + struct.pack("<I", 36 + data) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, sr, sr * 2, 2, 16) + b"data" + struct.pack("<I", data)


@app.get("/health")
def health() -> JSONResponse:
    return JSONResponse({"ok": True, "device": device, "voice": args.voice, "sr": model.sr, "loadSeconds": round(ready_at - t0, 1)})


@app.post("/v1/audio/speech")
def speech(req: Speech) -> Response:
    if req.voice and req.voice != args.voice:
        with lock:
            model.prepare_conditionals(req.voice)
            args.voice = req.voice
    if req.response_format == "wav":
        pcm = np.concatenate([synth(s) for s in sentences(req.input)])
        return Response(wav_header(len(pcm), model.sr) + pcm.tobytes(), media_type="audio/wav")

    def gen():
        for s in sentences(req.input):
            yield synth(s).tobytes()

    return StreamingResponse(gen(), media_type="audio/pcm", headers={"X-Sample-Rate": str(model.sr)})


uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
