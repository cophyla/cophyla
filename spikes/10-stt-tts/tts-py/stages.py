"""Where does generate() spend its time, call by call? T3 (GPU, autoregressive), S3Gen (GPU vocoder),
Perth watermark (CPU). Same sentence six times, then the paragraph's sentences."""
import os, re, sys, time, torch, psutil
if "pcores" in sys.argv:
    # 13700K: logical 0-15 are the 8 P-cores with HT, 16-23 the E-cores.
    psutil.Process().cpu_affinity(list(range(16)))
if "high" in sys.argv:
    psutil.Process().nice(psutil.HIGH_PRIORITY_CLASS)
print("affinity", psutil.Process().cpu_affinity(), "priority", psutil.Process().nice(), flush=True)
from chatterbox.tts_turbo import ChatterboxTurboTTS
m = ChatterboxTurboTTS.from_pretrained(device="cuda")
m.prepare_conditionals("../out/clips/en_long.edge.wav")
m.generate("Ready.")
# Wrap the three stages.
t3, s3, wm = m.t3.inference_turbo, m.s3gen.inference, m.watermarker.apply_watermark
times = {}
def timed(name, f):
    def g(*a, **k):
        torch.cuda.synchronize(); t = time.perf_counter(); r = f(*a, **k); torch.cuda.synchronize(); times[name] = time.perf_counter() - t; return r
    return g
m.t3.inference_turbo = timed("t3", t3); m.s3gen.inference = timed("s3gen", s3); m.watermarker.apply_watermark = timed("perth", wm)
para = "Here is where things stand. The Windows build is green and the installer was rehearsed at version zero point one point two. On Linux the same tree builds under WSL, and the daemon survives a shell restart. The Mac is still pending: it needs a signing identity before the notarized package can be tested. Nothing in the audit log shows a request that bypassed the gate. The only surprise was the wake word firing on the word travis."
sents = ["The Windows build is green and the installer was rehearsed at version zero point one point two."] * 4
print(f"{'chars':>5} {'audio':>6} {'t3':>6} {'s3gen':>6} {'perth':>6} {'total':>6}  tokens/s")
for s in sents:
    t = time.perf_counter(); wav = m.generate(s); total = time.perf_counter() - t
    audio = wav.shape[-1] / m.sr
    print(f"{len(s):>5} {audio:>6.2f} {times['t3']:>6.2f} {times['s3gen']:>6.2f} {times['perth']:>6.2f} {total:>6.2f}  {audio*25/times['t3']:>6.0f}", flush=True)
print("torch threads", torch.get_num_threads())
