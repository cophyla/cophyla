# Spike 11: the wake word in a real room

Date: 2026-09-20. Windows 11, Bun 1.3.14, the streaming pipeline and models of spike 04
(`hey_jarvis` and `alexa` from openWakeWord at int16 scale, `hey_livekit` from
livekit-wakeword at unit scale, two pipeline instances). Microphone: Brio 101 webcam on the
desk, Windows input volume 57 %. Speakers: Realtek, on the desk, at 8–14 % of Windows volume.

Question: does a phrase spoken in the room, not mixed into the samples, fire the classifier;
and how often do they fire on their own over hours?

**Answer: yes, at 0.93–1.00 from speakers at a low volume and at 0.80–0.97 from a voice in the
room; and on their own almost never on ordinary speech (0 to 0.19 fires an hour at 0.5 over
5.4 h of read speech, none at 0.7).** The exposure is near-rhymes: the stock openWakeWord
`hey_jarvis` fires on "say jarvis", on "jarvis" alone and half the time on "hey jargon". The
livekit head never rose above 0.38 on anything but its own phrase. The product's custom phrase
has to be trained with livekit-wakeword's adversarial negatives, as architecture.md already
says, and validated with exactly this set of tests. Both pipelines together cost 6.4 % of one
core on the room microphone.

## Results

### Acoustic pass (`01-acoustic.ts`), speakers at 14 %

Each clip is played through the speakers while the microphone runs through both pipelines;
the peak score during the clip is the result. Room baseline with nothing playing: mic RMS 5,
scores ≤ 0.0003 (`hey_livekit` 0.02).

| Clip | Trials | `hey_jarvis` | `alexa` | `hey_livekit` | Mic peak RMS |
|---|---|---|---|---|---|
| "hey jarvis", neural Guy / Jenny, SAPI David / Zira | 8 | **0.998–0.999** in 7; 0.028 once (Jenny #2, a 998-RMS noise in the room during it) | 0.000 | ≤ 0.08 | 103–363 |
| "hey live kit", neural Guy, SAPI Zira | 4 | 0.000 | 0.000 | **0.925–0.986** | 107–292 |
| "alexa", neural Guy | 2 | 0.000 | **1.000** | ≤ 0.03 | 176–179 |
| 11 s sentence, neural Guy | 2 | 0.000 | 0.001 | ≤ 0.04 | 840–6352 |

A first attempt ran into muted speakers: mic peak RMS 0–4, nothing detected, which is why the
script now prints the default output and input device with volume and mute state before it
plays anything (`audio-defaults.ps1`, CoreAudio through PowerShell).

### Near misses, one phrase per clip (neural Jenny, speakers at 8 %)

| Phrase | `hey_jarvis` (2 trials) | `hey_livekit` |
|---|---|---|
| "Hey Travis" | 0.28, 0.43 | 0.38, 0.04 |
| "Hey jargon" | **0.98**, 0.48 | 0.03, 0.05 |
| "Hey service" | 0.01, 0.12 | 0.07, 0.03 |
| "Hey Marvin" | 0.00, 0.00 | 0.05, 0.17 |
| "Say jarvis" | **0.999, 0.999** | 0.02, 0.03 |
| "Jarvis" alone | **0.53, 0.99** | 0.02, 0.02 |
| "Hey, Jarvis said he would call back later" | 0.998, 0.998 (contains the phrase: a true positive) | 0.03, 0.06 |
| spike 04's espeak "hey jargon, hey service, hey travis", 5 trials | 0.47, 0.68, 0.78, 0.44, 0.48 | ≤ 0.21 |

The "hey" carries almost no weight for the stock model; "jarvis" and its near-rhymes do.

### False accepts over 5.4 h of speech, digitally (`03-offline-hours.ts`)

LibriSpeech dev-clean (2,703 read-audiobook utterances, 40 speakers) as one continuous
stream through the three classifiers; 12.5 minutes of wall clock, 26× real time for both
pipelines including ffmpeg decode.

| Threshold | `hey_jarvis` /h | `alexa` /h | `hey_livekit` /h |
|---|---|---|---|
| 0.3 | 0.19 | 0.74 | 0.56 |
| 0.5 | **0** | **0.19** | **0.19** |
| 0.7 | 0 | 0 | 0 |
| 0.9 | 0 | 0 | 0 |

The one `alexa` fire at 0.5 was "ALEXANDER flushed angrily" (0.501); the one `hey_livekit`
fire was "…stand ready to obey any summons the police may send me" (0.668). Both are the
near-rhyme pattern, not noise.

### Hours on the room microphone (`02-listen.ts`)

Started 05:44 local for 6 h; every score ≥ 0.3 is logged and every ≥ 0.5 keeps a 3 s
snippet. After 0.5 h: 62 events, 59 of them during the acoustic runs above (the listener
hears the speakers too). The other three, 20 s before the first clip played, at mic RMS
77 and 12: `hey_jarvis` 0.972 and 0.802 (and a 0.365), which `04-label-snippets.ts`
transcribes as "Hey Jarvis" and "Hey Javis": **a voice in the room, detected twice.** No fire
on its own otherwise, but the room carried sound in only 2 % of the frames so far; the
per-hour number waits for a day of use. The final table is in `out/listen-summary.json`.

Labelling by transcript works: every snippet from the acoustic runs reads back as the clip
that was playing ("Hey Jarvis", "Say Jarvis", "Hey Jargon", "Alexa", "Hey live kit"), so a
long run needs no one to listen to its snippets.

## Findings

1. **The acoustic path costs nothing in score.** Speakers at 8–14 % into a webcam mic across
   a desk give 0.998 where spike 04's digital mix gave 0.981. One miss in 24 positive trials,
   with a loud transient in the room at the time.
2. **The stock openWakeWord `hey_jarvis` is a "jarvis" detector.** The prefix is not
   required and near-rhymes of the second word fire it. That is the weakness livekit's
   adversarial negatives address; the `hey_livekit` head stayed low on every near miss here.
   A custom phrase should be trained with livekit-wakeword and tested against: the phrase
   without its prefix, the second word alone, and rhymes of each word.
3. **Ordinary speech barely fires any of them.** 0–0.19 an hour at 0.5 over 5.4 h of clean
   read speech, 0 at 0.7. A threshold of 0.7 costs no true positive in the acoustic table
   (every real detection was ≥ 0.80) and removes the rare speech fire.
4. **Two pipeline instances cost 6.4 % of a core**, near spike 04's 5 % for one: the heads are
   cheap, the mel and embedding passes dominate, and there are two of those because the
   two projects scale the input differently. One project's models only would be 5 %.
5. **Transcribing the snippets labels a long run automatically.** The Nemotron STT of spike
   10 read every snippet correctly, including the near misses.
6. **Check the audio devices before trusting silence.** A muted default output looks exactly
   like a model that hears nothing.

## Not verified

- A person at several distances and a custom-trained phrase; only two human events so far.
- Hours of the room with people talking; a noisy room; music.
- The phone as the microphone (spike 12 runs the same classifiers over the phone's stream).

## Files and commands

Run from this folder. `bun install`; the models are spike 04's (`../04-voice/models`).

| File | What it does | Command |
|---|---|---|
| `wake.ts` | both pipelines over one stream; the default microphone | imported |
| `audio-defaults.ps1` | default output/input device, volume, mute | `powershell -File audio-defaults.ps1` |
| `01-acoustic.ts` | plays each clip through the speakers, peak score per classifier | `bun 01-acoustic.ts [repeats] [only]` |
| `02-listen.ts` | hours on the room mic; `out/listen.jsonl`, `out/listen-summary.json`, `out/snippets/` | `bun 02-listen.ts [hours]` |
| `03-offline-hours.ts` | LibriSpeech dev-clean through the classifiers, fires per hour by threshold | `bun 03-offline-hours.ts [maxHours]` |
| `04-label-snippets.ts` | transcribes every kept snippet with spike 10's STT | `bun 04-label-snippets.ts` |

Clips: `out/*.edge-*.wav` and `out/nm_*.wav` from `uvx edge-tts` (neural voices; a few short
phrases were sent to Microsoft), plus spike 04's SAPI and espeak clips. LibriSpeech
(gitignored, 337 MB):

```
cd models && curl -sSLO https://www.openslr.org/resources/12/dev-clean.tar.gz && tar xzf dev-clean.tar.gz
```

`out/snippets/` holds room audio around each wake event; delete after the run.
