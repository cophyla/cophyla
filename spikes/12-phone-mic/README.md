# Spike 12: a phone browser's microphone

Date: 2026-09-20. Node side: Windows 11, Bun 1.3.14, the engines of spikes 04 and 10. Network:
one Wi-Fi LAN, the node at 192.168.1.44, Windows Firewall on with an existing inbound allow
rule for `bun.exe` on the Public profile.

Question: can a phone browser on the LAN capture the microphone at 16 kHz mono, stream it to
the node, and play speech back, the way the controller of milestone 8 must? What does the
secure-context rule cost on a LAN with no real certificate?

**Answer: yes, on Android Chrome, the whole loop.** The self-signed certificate can be passed
by hand, after which the page is a secure context and `wss://` connects on the same override;
`getUserMedia` gives a 48 kHz mono track with echo cancellation, noise suppression and gain
control on, and Chrome runs the `AudioContext` at the 16 kHz the page asks for, so the
worklet does no resampling. The stream arrived at exactly 16,000 samples a second for 96 s
with no loss; the wake word fired four times from the phone's microphone at 0.94–0.997, the
questions came back as text while they were still being spoken, and the spoken reply reached
the phone 0.8–1.4 s after each final. Push-to-talk worked. iOS is untested.

## What runs

`server.ts` is the node: HTTPS and WSS on `0.0.0.0:8443` with a self-signed certificate
whose SAN is the LAN address, serving `page.html` and `worklet.js`. Over the socket it runs
the voice pipeline of architecture.md on the phone's stream: both wake-word classifiers of
spike 11 on every chunk; on a wake or push-to-talk, Silero VAD and the Nemotron STT of spike
10 with partials sent back as they change; on the VAD closing the utterance (or the button
being released) the final text, then `You said: …` synthesized by the `tts-py` sidecar of
spike 10 and streamed back as 24 kHz PCM, one sentence at a time. Its states are the
`voice.state` values: idle, listening, thinking, speaking.

`page.html` asks for `getUserMedia({audio: {channelCount: 1, sampleRate: 16000,
echoCancellation, noiseSuppression, autoGainControl}})`, opens an `AudioContext` at 16 kHz
inside the tap (iOS unlocks output only in a gesture), falls back to the default rate, and
runs `worklet.js`, which resamples to 16 kHz if the context refused, converts to int16 and
posts 40 ms chunks that the page sends as binary frames. Speech coming back is scheduled as
`AudioBuffer`s at 24 kHz, which the context resamples. A hold-to-talk button sends
`voice.ptt`-shaped messages; an "always transcribe" toggle bypasses the wake word for STT
testing. The page shows what the browser reported: `isSecureContext`, the track's real
settings, the context's rate, and every second the server's view of the stream.

## Results

### The stand-in first

`01-fake-phone.ts` stands in for the phone from Bun: it connects over WSS with the
self-signed certificate accepted, and streams silence, "hey jarvis" (a neural voice), a
0.4 s pause, "What time is the meeting tomorrow afternoon" (SAPI), and silence, in 40 ms
chunks at real time.

| Moment | Time from connect | Note |
|---|---|---|
| "hey jarvis" clip starts | 2.95 s | |
| wake fires, `hey_jarvis` 0.993 | 4.12 s | 1.17 s into a 1.2 s clip: the phrase must be complete |
| question clip starts | 5.66 s | |
| first partial "What time is the" | 6.97 s | 1.3 s in |
| last partial, full sentence | 8.28 s | before the clip ends (8.6 s) |
| final, from the VAD | 9.07 s | 0.5 s after the clip's last word |
| first speech chunk back | 10.14 s | 1.07 s after the final; 2.8 s of audio in one sentence |
| back to idle | 10.14 s | the whole reply was sent before playback would have finished |

With `--ptt` (button held for the question, no wake word): partials the same, final at
release with no VAD wait, first speech chunk 1.13 s later.

A desktop Playwright browser refuses the certificate outright
(`ERR_CERT_AUTHORITY_INVALID`, no interstitial), so the browser side could not be driven from
here; the phone was.

### The phone: Android Chrome 152, over Wi-Fi (`out/hello-3.json`, `out/stats.jsonl`)

| | Result |
|---|---|
| Certificate warning | passed by hand (Advanced → proceed) |
| `isSecureContext`, origin | `true`, `https://192.168.1.44:8443` |
| `wss://` on the same override | connected |
| `getUserMedia` track | `sampleRate` 48000, `channelCount` 1, `echoCancellation` / `noiseSuppression` / `autoGainControl` all `true`, `latency` 0.01, `voiceIsolation` false |
| `AudioContext({sampleRate: 16000})` | honoured: 16 kHz, `running`; the worklet's ratio was 1 |
| Samples per second at the server, 95 s | median 16,000, min 14,720, max 17,280; 1,534,720 samples in 95.9 s: **nothing lost** |
| Chunks per second | 23–27 (40 ms chunks) |
| Largest gap between chunks | median 91 ms, p95 169 ms, max 408 ms (Wi-Fi jitter, absorbed) |
| Level | RMS median 1 in silence, peaks to full scale when speaking: the phone's gain control |
| Wake word from the phone mic | `hey_jarvis` fired 4 of 4 times, 0.940–0.997; `hey_livekit` never above 0.07 |
| Finals (VAD) | "Uh, how are you doing" · "How are you doing" · "What's your name" · "Can you tell me which sections are currently running please" |
| Finals (push-to-talk) | "Hello One"; two accidental 75 ms and 124 ms taps gave empty finals and, correctly, no reply |
| Decode while listening | p50 105 ms per 560 ms chunk, max 231 ms |
| Reply: final → first speech chunk sent | 0.76–1.37 s, scaling with the reply's length |
| Page hidden | the socket closed in the same second the page reported `visibility hidden` (track still live at that moment): the tab was closed or Chrome dropped it; background listening is not settled |

## Findings

1. **A self-signed certificate is usable on Android Chrome, by hand, once.** After the
   interstitial the origin is a secure context and the socket connects; nothing else was
   needed. Whether the override survives a browser restart, and what iOS Safari does, are
   open. For the product the choices remain: a CA the installer makes once and the phone
   installs (mkcert-style), a tailnet's certificate, or a native app that pins the node's key.
2. **Chrome delivers 16 kHz when asked.** `AudioContext({sampleRate: 16000})` ran at 16 kHz
   over a 48 kHz track, so the browser resampled and the worklet only packed int16. The
   resampler in `worklet.js` stayed unused; it is there for browsers that refuse the rate.
3. **The phone's processing is on by default and is what the wake word wants.** AGC brought a
   quiet voice to full scale; noise suppression kept silence at RMS 1; echo cancellation let
   the mic stay open while the phone played the reply, with no re-trigger.
4. **Wi-Fi jitter is not loss.** Gaps of up to 0.4 s between chunks, and still every sample
   arrived; the server side needs only a small buffer, not a jitter model.
5. **Two states of the pipeline are visible to the user as latency**: wake → listening
   costs nothing; final → speech is 0.8–1.4 s here, all of it the TTS, and it grows with the
   reply. A lead-in ("One moment…") or per-sentence streaming of the brain's answer covers it.
6. **Short accidental push-to-talk taps produce empty finals.** The node must not wake the
   brain on an empty utterance; the spike's server does not, and cophylad's `voice` should not.
7. **The web controller cannot listen with the page hidden**, at least not as built: the
   stream ended with the page. A wake lock keeps the screen on but is not background audio.
   This is the case for the native controller of milestone 12, and for the product a web
   controller that listens only while open.

## Not verified

- iOS Safari: the certificate path, `AudioContext` rate, `getUserMedia` in a hidden tab.
- Whether Chrome's certificate override persists across browser restarts.
- Background behaviour on purpose: the phone locked with the page open, the app switched.
- Two phones at once (the server shares one recognizer stream per connection but one VAD).
- A tailnet or a relay in the path; only the LAN was used.

## Files

| File | What it does | Command |
|---|---|---|
| `server.ts` | HTTPS + WSS node; wake → VAD → STT → TTS over the phone stream; logs to `out/` | `bun server.ts [--tts] [--port 8443]` |
| `page.html`, `worklet.js` | the phone page and its capture worklet | served |
| `01-fake-phone.ts` | a Bun client that streams clips at real time and prints the loop | `bun 01-fake-phone.ts [host] [--ptt]` |
| `out/cert.pem`, `out/key.pem` | the self-signed certificate, 30 days, SAN `IP:192.168.1.44` | `openssl req -x509 -newkey rsa:2048 -nodes -keyout out/key.pem -out out/cert.pem -days 30 -subj "/CN=cophyla-spike-12" -addext "subjectAltName=IP:192.168.1.44,DNS:localhost"` |

`out/` (gitignored) holds the certificate, `server.log`, per-second `stats.jsonl` while a
phone is connected, and each phone's `hello-<n>.json` with what its browser reported.
