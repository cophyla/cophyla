"""The tts-py sidecar shape: Chatterbox Turbo behind an OpenAI-compatible speech endpoint on
loopback, streaming raw PCM sentence by sentence so the first audio leaves before the rest is
synthesized. Run by hand, or spawned by 05-tts-client.ts the way `sidecars` would.

    .venv/Scripts/python server.py --port 8321 --device cuda --voice ../out/clips/en_long.edge.wav --affinity 0-15

  GET  /health                    -> {"ok": true, "device": ..., "voice": ..., "sr": 24000}
  POST /v1/audio/speech           {"input": text, "response_format": "pcm" | "wav", "voice"?: path}
                                  pcm: chunked int16 little-endian mono at 24 kHz, one chunk per sentence
                                  wav: the whole clip, one response
"""
import argparse
import io
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
parser.add_argument("--host", default="127.0.0.1")
parser.add_argument("--device", default="cuda")
parser.add_argument("--voice", default="../out/clips/en_long.edge.wav")
parser.add_argument("--affinity", default="", help="logical CPUs to run on, e.g. 0-15: on a hybrid Intel CPU the token loop is launch-bound and 3x slower on E-cores")
args = parser.parse_args()
if args.affinity:
    import psutil
    lo, hi = (int(x) for x in args.affinity.split("-"))
    psutil.Process().cpu_affinity(list(range(lo, hi + 1)))

t0 = time.perf_counter()
from chatterbox.tts_turbo import ChatterboxTurboTTS  # noqa: E402

model = ChatterboxTurboTTS.from_pretrained(device=args.device)
model.prepare_conditionals(args.voice)
model.generate("Ready.")  # warm the kernels so the first request is not the slow one
print(f"tts-py ready on {args.host}:{args.port} in {time.perf_counter() - t0:.1f} s ({args.device}, voice {args.voice})", flush=True)

lock = threading.Lock()  # one synthesis at a time: the GPU is shared with whatever else runs
app = FastAPI()


class Speech(BaseModel):
    input: str
    response_format: str = "pcm"
    voice: str | None = None
    model: str | None = None


def sentences(text: str):
    parts = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]
    return parts or [text]


def synth(text: str) -> np.ndarray:
    t = time.perf_counter()
    with lock:
        wav = model.generate(text)
    print(f"  synth {len(text)} chars -> {wav.shape[-1] / model.sr:.2f} s audio in {time.perf_counter() - t:.2f} s (thread {threading.current_thread().name})", flush=True)
    return (wav.squeeze(0).numpy() * 32767).clip(-32768, 32767).astype("<i2")


def wav_header(n_samples: int, sr: int) -> bytes:
    data = n_samples * 2
    return b"RIFF" + struct.pack("<I", 36 + data) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, sr, sr * 2, 2, 16) + b"data" + struct.pack("<I", data)


@app.get("/health")
def health():
    return {"ok": True, "device": args.device, "voice": args.voice, "sr": model.sr}


@app.post("/v1/audio/speech")
def speech(req: Speech):
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
