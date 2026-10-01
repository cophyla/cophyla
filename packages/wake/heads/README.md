# Cophyla's own wake-word heads

Keyword heads trained for Cophyla, the only ones it ships. Each takes the
16 × 96 embedding window `WakePipeline` feeds every head and returns one score; each is
listed with its threshold, its patience, its phrase and how that is said in the
`wake-openwakeword` model's manifest (`apps/cophylad/src/voice/catalog.ts`, `head_params`), and
the phone and the desktop app carry copies (`packages/voicehost/src/wake/bundled.ts`, pinned by
sha256). Which of them listen is the node's `[voice] wake_model` unless the app's Settings
picked others; a node listens for the two v0.2 heads by default.

| File | Says | Threshold | Patience | Checked against |
|---|---|---|---|---|
| `cophyla_v0.2.onnx` | "Cophyla", ko-FILL-uh (also kuh-FILL-uh) | 0.7 | 3 | 95% of 600 held-out synthetic clips; 0.93 false wakes an hour on 10.7 h of general audio |
| `hey_phyla_v0.2.onnx` | "Hey Phyla", hey FILL-uh | 0.8 | 3 | 83% of 600 held-out synthetic clips; 0.28 false wakes an hour |
| `cophyla_v0.1.onnx` | "Cophyla", ko-FY-la, the name's first sound | 0.7 | 1 | 91.6% recall, no false accepts on 19.8 h of validation negatives |
| `hey_phyla_v0.1.onnx` | "Hey Phyla", hey FY-la | 0.6 | 1 | 93.4% recall, 0.10 false accepts an hour |

The patience is how many 80 ms chunks in a row a head must score at or over its threshold
before it fires. The false wakes an hour above are counted the way the app listens: the
general-audio stream (openWakeWord's validation features, 10.7 h of speech, music and noise)
slid one chunk at a time, a wake needing that patience, and 16 chunks unscored after each one.
On the same stream, at the thresholds they ship at and a patience of one, the v0.1 heads wake
0.28 and 1.22 times an hour.

## How they were made

[livekit-wakeword](https://github.com/livekit/livekit-wakeword) (Apache-2.0), run in WSL on an
RTX 4080, with two changes to its checkout: features are computed from int16-range samples
(`audio * 32768` before the mel model), as openWakeWord feeds its own heads, as the
precomputed negative features were made and as `WakePipeline` runs every head here (upstream
reads clips at −1..1 but trains against those int16 features); and the trainer takes a random
quarter of the ACAV100M features (1.4 M windows) so its page cache stays a few GB.

Every head: 15,000 clips of Piper VITS (`en-us-libritts-high`, 904 speakers blended by SLERP)
saying the phrase at three speeds and two noise scales, 2,500 more for validation; 15,000 clips
of near misses (hand-picked phrases plus the phoneme substitutions livekit-wakeword derives from
CMUdict); openWakeWord's precomputed ACAV100M features and MUSAN noise; all augmented twice (room
impulse responses, background, gain). The classifier is conv + attention, medium, 60,000 steps.

### v0.2: ko-FILL-uh

- Positives: "co-filla" and "co filla", which espeak-ng reads as kˈoʊfˈɪlə and kˈoʊ fˈɪlə, and
  "cophila", kəfˈɪlə; "hey filla", "hey, filla" (hˈeɪ fˈɪlə). livekit-wakeword splits a word
  CMUdict does not know into ones it does before espeak reads it, so each spelling was checked
  as Piper would get it: "cophilla" becomes "cop hilla". Then 96 clips of the eight Kokoro
  voices the check below does not use, saying "Kohfilla" and "Cophila" (or "Hey Filla") at three
  speeds, five times over, in a second pass that trained the classifier once on the lot.
- Near misses: "go fill a", "so fill a", "coffee", "copilot", "profile a function", "gorilla",
  "vanilla", "Priscilla" and their like for "Cophyla"; "hey fella", "hey Stella", "hey Phil",
  "hey Tyler" and their like for "Hey Phyla", which also has "Cophyla" and "filla" alone, so
  it needs the "hey". 4,000 more clips of them went in twice in the second pass.
- livekit-wakeword searches CMUdict for a word of two sounds or fewer as a bare pattern, which
  matches every word that holds it anywhere: for "co filla" it made "frisco filla", "unesco
  filla" and 700 like them, the whole wake word, as negatives (v0.1 had "frisco phyla"). Those
  were dropped: every generated phrase whose espeak phonemes hold the target's.
- Mining the ACAV100M windows the head scores high and training again found nothing to mine:
  "Cophyla" scores 36 of the 1.4 M windows over 0.1 and none over 0.2.

Checked against clips no training used — three Kokoro voices and Windows' David and Zira,
through the node's pipeline, with 16 near misses of which ten are in no training list:

- "Cophyla" fired in 16 of 20 clips at 0.7 with a patience of three: "Kohfilla" and "Cophila",
  alone and before a question. Zira's "Co-filla" (0.55–0.64) and one Kokoro voice before a
  question (0.52–0.68) stayed under. "Go fill a bucket", a sound away, scored 0.13–0.79 and
  crossed 0.7 in one voice; "So fill it up again" peaked at 0.55; every other near miss stayed
  under 0.27, and the old ko-FY-la under 0.06.
- "Hey Phyla" scored 0.95–0.98 in all ten clips. "Hey fella" (0.78–0.96), a vowel away, crosses
  0.8 in four of five voices; every other near miss stayed under 0.62. It fires on "Cophyla" too,
  which wakes the node all the same.

### v0.1: ko-FY-la

- Positives: "co-phyla", "co phyla", "ko-fyla", which espeak-ng reads as kˈoʊfˈaɪlə; "hey
  phyla", "hey, phyla".
- "Cophyla" then had a second and a third pass: the first head fired on "profile a function"
  (up to 0.90), a single sound away, so 6,000 more Piper clips of near misses, most of them
  "profile a …", went in twice over, with 48 clips of the eight Kokoro voices the check does not
  use saying the word, alone and followed by a question, five times over; the classifier was
  trained again on the lot. "Hey Phyla" had a second pass of the same kind against "Hey Tyler"
  and its neighbours; it lost recall on the phrase and on validation without settling them, and
  the first head is the one kept.
- "Cophyla" scored 0.93–0.98 in four voices; Zira, who says "co-phyla" as two words, was missed
  (0.07–0.18). "Profile a function" peaked at 0.46. "Hey Phyla" scored 0.95–0.98 in all five
  voices, and also fires on "hey" before a name that rhymes: "Hey Tyler" (0.15–0.97), "Hey
  Skyler" (0.11–0.95) and "Hey Tyra" (0.64–0.88) cross its threshold in 11 of those 15 clips.
- They do not wake on ko-FILL-uh: Windows' David scores 0.98 saying "Co-phyla" and 0.02
  saying "Co-filla".

The heads are trained on synthetic voices alone, and a real voice scores lower than these
checks: recordings of the people who use it, saying the words and talking near the microphone,
are what would raise it most.

The precomputed ACAV100M and validation features are CC BY-NC-SA 4.0 (their dataset cards,
`binhpham/livekit_wakeword_features` and `davidscripka/openwakeword_features`), and MIT's room
impulse responses (`davidscripka/MIT_environmental_impulse_responses`) state no licence. A head
trained without them — negatives from permissively licensed speech run through the same feature
models, and impulse responses under an open licence — would be free of that.
