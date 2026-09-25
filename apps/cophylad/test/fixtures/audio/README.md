# Audio fixtures

Two 16 kHz mono PCM clips the live engine check runs on, synthesized with the Windows SAPI
voice Microsoft Zira during spikes 04 and 10 and copied here so the check needs no
microphone and no network.

| File | Words | From |
|---|---|---|
| `hey_jarvis.wav` | "hey jarvis" | `spikes/04-voice/out/clips/hey_jarvis.MicrosoftZiraDesktop.wav` |
| `question.wav` | "What time is the meeting tomorrow afternoon?" | `spikes/10-stt-tts/out/clips/en_short.zira.wav` |

`voice-engines.live.test.ts` is skipped unless the four model directories are present under
`apps/cophylad/models/voice/` (or `COPHYLA_VOICE_MODELS` names another directory of them), because
they are a gigabyte and are fetched by `apps/cophylad/scripts/fetch-models.ts --voice`.
