# Spike 17: the node's helper for direct connections, before building on it

Date: 2026-09-24. Windows 11 (build 26200), WSL Ubuntu, Rust 1.98.1, `rtc` 0.21.0 (the
sans-IO core of webrtc-rs), `portmapper` 0.19.3, Bun 1.3.14, headless Chromium 151
(Playwright's `chromium_headless_shell-1234`), Playwright's WebKit build 2336.

Milestone 16 puts a small Rust helper, `cophyla-net` (`apps/net`), between cophylad and the
network: WebRTC data channels to phones and to other nodes, all on one UDP port. Spike 16
proved WebRTC under Bun with libdatachannel. This spike checks what the helper is built on
before cophylad is: the sans-IO `rtc` crate against a browser, one port shared by every peer,
the port mapping, the loopback page a stream is served through, and the pieces cophylad's
pipes and moonlight-web's ICE-server script lean on.

**Verdict: build on `rtc`, with its send window kept small.**
- `rtc` talks to Chromium and to itself on one shared port. Channels open in 180–335 ms,
  echo round trips are sub-millisecond on a short path, and the helper reports the path.
- Its SCTP recovers a burst lost from a large window only by its retransmission timer,
  whose floor is 1 s. Keeping at most 128 KiB unacknowledged per peer avoids that. Node →
  phone then matches libdatachannel on the same path, 10.5–11.1 MB/s at 19 ms.
- Phone → node through that path stays at 0.7–0.8 MB/s (libdatachannel: 9.1). That
  direction carries the phone's typing, taps and voice, all small, so it is left as a
  known limitation.
- Loopback pages: a cookie without `Secure` works in both engines; WebKit drops a `Secure`
  one over `http://127.0.0.1`. So the loopback server's cookie must not be `Secure`.
- Bun can hold back a TCP connection's reads, and a Rust `Command` runs a `.cmd` script.
- Still to check, with the user at the desk: the Windows firewall on a fresh exe, the port
  mapping against this router from Windows, and Android WebView. See the end.

## What is here

- **`chromium.ts`:** plays cophylad against headless Chromium playing the phone. It runs the
  helper on its stdio and carries the offer, answer and candidates. Then it measures an echo
  round trip and a megabyte each way, and reads the path from both ends.
  - `--peers 2`: two pages at once, on the helper's one port.
  - `--only-srflx`: both ends keep only their reflexive candidates, so the path leaves
    through the router and comes back in (a hairpin), ~19 ms.
  - `--predict-shift n`: the page's reflexive port is told `n` lower, so the helper has to
    predict it.
- **`pair.ts`:** two helpers linked the way two nodes will be, one offering.
- **`cookie.ts`:** a loopback ticket page in Chromium and WebKit: the cookie, the secure
  context, WebCodecs, WebRTC.
- **`tcp-pause.ts`:** Bun's TCP `pause()` and `resume()` under a 64 MB stream.

The helper ran in WSL (`~/m16-net`, a copy of `apps/net`), so nothing bound a LAN address
on Windows before the firewall check below. Headless Chromium ran on Windows, as in spike 16.

```
node --experimental-strip-types chromium.ts --helper wsl-release [--peers 2] [--only-srflx] [--predict-shift 3] [--mb 4]
node --experimental-strip-types pair.ts
bun cookie.ts & node --experimental-strip-types cookie.ts --drive
bun tcp-pause.ts
```

## Results

| Test | Result |
|---|---|
| `rtc` ↔ `rtc`, loopback, in one process (`apps/net` `tests/loopback.rs`) | The channel opens. 1 MiB goes over in 64 frames of 16 KiB, frame for frame, and both ends report `host`. A close is heard at the far end. |
| Chromium → helper, WSL, 3 runs | <ul><li>Open 243–271 ms.</li><li>Echo p50 0.5 ms.</li><li>Up 16–33 MB/s, down 32–33 MB/s.</li><li>Path `prflx`: Chromium's host candidate is an mDNS name, so the helper learns the page's address from its checks.</li></ul> |
| Two pages at once on the helper's one port | Both open in ~275 ms. Each gets its own 1 MiB each way, frame for frame, at 23 MB/s up and 35 MB/s down. |
| Reflexive only, through the router (hairpin), 19 ms | <ul><li>Open 306–335 ms.</li><li>Path `srflx` on both ends.</li><li>Down (helper → page) **10.5–11.1 MB/s** with the 128 KiB window. Before it: 0.4–0.9 MB/s.</li><li>Up (page → helper) **0.7–0.8 MB/s**.</li><li>Spike 16's libdatachannel node on the same path and at the same RTT: 11.4 down, 9.1 up.</li></ul> |
| The page's reflexive port told 3 low | Connects every run, 255–279 ms. The helper added the predicted candidates. On this path the page's own checks reach the helper first, so the pair comes up `prflx`, not `predicted`. A true sequential NAT needs the phone pass. |
| Helper ↔ helper (`pair.ts`), WSL, same host | Open in 20 ms, echo 0.5 ms, 80–90 MB/s each way. |
| STUN through the helper's port | The reflexive address arrives at the first round, and `net.state` reports it. |
| `portmapper` in WSL | No UPnP, NAT-PMP or PCP answers behind Windows' own NAT, as expected. The home router needs the Windows run. |
| Loopback ticket page, Chromium | Cookie without `Secure`: sent. With `Secure`: also sent, since Chromium counts loopback as trustworthy. `isSecureContext`, `VideoDecoder` and `RTCPeerConnection` are all present. |
| Same, WebKit (Playwright's Windows build) | Cookie without `Secure`: sent. **With `Secure`: not sent.** `isSecureContext` is true. No `VideoDecoder` and no `RTCPeerConnection` in this build. |
| Bun `socket.pause()` / `resume()` (Windows) | Nothing arrives in 500 ms paused. The writer sees short writes and `drain`. 64 MB in 1.05 s end to end. |
| Rust `Command` on a `.cmd` with a space in its path, no arguments | Runs through `cmd.exe`. Stdout is the JSON file, or `[]` without it. |

## What the SCTP result means

The trace (rtc-sctp's own log, from a throwaway build) shows how the slow runs went:
- slow start grew the congestion window to 300–540 KB;
- a burst was lost;
- fast retransmit sent one chunk;
- then the retransmission timer fired, once or twice, each time after at least a second
  (`RTO_MIN` is 1000 ms in rtc-sctp and not configurable);
- each firing put the window back at one packet.

libdatachannel's usrsctp takes the same losses and recovers them without the timer.

Two changes in the helper, both kept:
- **Queue what a socket will not take.** A burst larger than the socket's buffer used to be
  dropped on `WouldBlock`, which SCTP read as congestion. The socket buffers are also
  raised (2 MB send, 4 MB receive, as far as the system allows).
- **At most 128 KiB unacknowledged per peer.** The rest waits in the helper. That caps a
  peer's rate at 128 KiB per round trip: ~6.5 MB/s at 19 ms, ~1.3 MB/s at 100 ms. That is
  enough for cophylad's frames. The desktop's video does not use this channel: it goes over
  moonlight-web's own WebRTC.

The phone → node direction has `rtc` as the receiver:
- A patched copy that acknowledges every packet at once (`AckMode::NoDelay`, crate-private
  upstream) lifted it to 1.3–2.4 MB/s, so the delayed acknowledgement is part of it.
- Not kept: it means shipping a patched copy of the crate.
- What the phone sends is small, so it stays as it is. It is noted as an upstream issue:
  configurable acknowledgements and retransmission floor.

## Findings for the build

- **Candidates can arrive before the answer is made.** In `pair.ts` the offering helper's
  candidates reached the answering one before `peer.answer`, and were refused as an
  unknown peer. The connection came up anyway, through checks. cophylad holds a peer's early
  candidates until its offer or answer is done.
- **A pair from an early check is `prflx`** even after the candidate arrives. The helper
  names such a remote by the type the far end sent for that address, so a same-LAN path
  still reports `host`.
- The stats' candidate-pair entries name their candidates without the prefix the candidate
  entries carry. The helper reads the selected pair from the ICE transport instead.
- The helper's release build is 9 MB stripped.

## With the user at the desk

1. **Windows firewall.** Does binding the helper's UDP port on a LAN address, from a freshly
   copied exe at a fixed path, raise the prompt? Does the path still work after Cancel?
   Every profile here has `NotifyOnListen` on.
2. **`portmapper` against the home router, from Windows.** Spike 16 found none of the
   protocols from Bun.
3. **Android WebView** (the debug APK): the loopback cookie without `Secure`, the secure
   context, `VideoDecoder`.
4. **moonlight-web v2.10.0** running `--webrtc-ice-server-script` as a `.cmd` in a real
   stream. The mechanism itself is checked above.
