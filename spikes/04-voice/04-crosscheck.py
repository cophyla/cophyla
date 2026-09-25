# Reference side of 04-crosscheck.ts: stream the same wavs through openwakeword in 80 ms chunks.
import json, os, wave
import numpy as np
from openwakeword.model import Model

heads = ["models/hey_jarvis_v0.1.onnx", "models/alexa_v0.1.onnx"]
out = {}
for name in sorted(os.listdir("out/xcheck")):
    if not name.endswith(".wav"):
        continue
    with wave.open(os.path.join("out/xcheck", name), "rb") as w:
        audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    model = Model(wakeword_models=heads, inference_framework="onnx",
                  melspec_model_path="models/melspectrogram.onnx",
                  embedding_model_path="models/embedding_model.onnx")
    rows = {k: [] for k in model.models.keys()}
    for i in range(0, len(audio) - 1279, 1280):
        pred = model.predict(audio[i:i + 1280])
        for k, v in pred.items():
            rows[k].append(float(v))
    out[name] = rows
json.dump(out, open("out/xcheck/ref.json", "w"))
