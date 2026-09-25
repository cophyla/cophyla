"""Step 3: Chatterbox Turbo on this machine. Load time, VRAM, clone from a reference clip, and the
wall time / real-time factor for a short line, a medium answer and a paragraph, whole and split
by sentence (time to first audio for the sidecar).

    .venv/Scripts/python bench.py [cuda|cpu] [reference.wav]
"""
import json
import re
import sys
import time
from pathlib import Path

import torch
import torchaudio as ta

device = sys.argv[1] if len(sys.argv) > 1 else "cuda"
ref = sys.argv[2] if len(sys.argv) > 2 else "../out/clips/en_long.edge.wav"
short_only = "short" in sys.argv[3:]  # CPU: one line is enough to know
out = Path("../out/tts"); out.mkdir(parents=True, exist_ok=True)

def vram():
    if device != "cuda":
        return None
    return {"allocatedMB": round(torch.cuda.memory_allocated() / 2**20), "reservedMB": round(torch.cuda.memory_reserved() / 2**20),
            "peakMB": round(torch.cuda.max_memory_allocated() / 2**20)}

def rss():
    import psutil  # noqa
    return round(psutil.Process().memory_info().rss / 2**20)

report = {"device": device, "reference": ref}
t0 = time.perf_counter()
from chatterbox.tts_turbo import ChatterboxTurboTTS  # noqa: E402
model = ChatterboxTurboTTS.from_pretrained(device=device)
report["loadSeconds"] = round(time.perf_counter() - t0, 2)
report["vramAfterLoad"] = vram()
print(f"loaded in {report['loadSeconds']} s, vram {report['vramAfterLoad']}", flush=True)

t0 = time.perf_counter()
model.prepare_conditionals(ref)
report["cloneSeconds"] = round(time.perf_counter() - t0, 2)
print(f"reference voice prepared in {report['cloneSeconds']} s", flush=True)

texts = {
    "short": "Done. The tests pass on all three platforms.",
    "medium": "Three tests failed in the protocol package, all in the fixture round-trip. The schema for voice.speak gained a field that the fixtures do not carry yet. I can add it and rerun, or open a pull request with the change.",
    "paragraph": "Here is where things stand. The Windows build is green and the installer was rehearsed at version zero point one point two. On Linux the same tree builds under WSL, and the daemon survives a shell restart. The Mac is still pending: it needs a signing identity before the notarized package can be tested. Nothing in the audit log shows a request that bypassed the gate. [chuckle] The only surprise was the wake word firing on the word travis.",
}

def synth(text):
    if device == "cuda":
        torch.cuda.synchronize()
    t = time.perf_counter()
    wav = model.generate(text)
    if device == "cuda":
        torch.cuda.synchronize()
    return wav, time.perf_counter() - t

# Warm-up: the first call compiles kernels and allocates.
_, warm = synth("Hello.")
report["warmupSeconds"] = round(warm, 2)
print(f"warm-up {warm:.2f} s", flush=True)

runs = []
for name, text in texts.items():
    if short_only and name != "short":
        continue
    wav, wall = synth(text)
    audio = wav.shape[-1] / model.sr
    ta.save(str(out / f"{name}.{device}.wav"), wav, model.sr)
    row = {"name": name, "chars": len(text), "wallSeconds": round(wall, 2), "audioSeconds": round(audio, 2), "rtf": round(wall / audio, 3), "vram": vram()}
    runs.append(row)
    print(row, flush=True)

# Per sentence: what a sidecar would stream. First sentence's wall = time to first audio.
sentences = [] if short_only else [s for s in re.split(r"(?<=[.!?])\s+", texts["paragraph"]) if s]
pieces, walls = [], []
t_start = time.perf_counter()
for s in sentences:
    wav, wall = synth(s)
    pieces.append(wav)
    walls.append(round(wall, 2))
total = time.perf_counter() - t_start
joined = torch.cat(pieces, dim=-1) if pieces else torch.zeros(1, 1)
if pieces:
    ta.save(str(out / f"paragraph-sentences.{device}.wav"), joined, model.sr)
report["perSentence"] = None if not pieces else {"sentences": len(sentences), "wallEach": walls, "timeToFirstAudioSeconds": walls[0],
                         "totalWallSeconds": round(total, 2), "audioSeconds": round(joined.shape[-1] / model.sr, 2),
                         "rtf": round(total / (joined.shape[-1] / model.sr), 3)}
print(report["perSentence"], flush=True)
report["runs"] = runs
report["vramPeak"] = vram()
try:
    report["rssMB"] = rss()
except Exception:
    pass
(out / f"bench.{device}.json").write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
