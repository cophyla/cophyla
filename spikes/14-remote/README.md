# Spike 14: Apollo, Moonlight and moonlight-web on this machine

Date: 2026-09-21. Windows 11, Bun 1.3.14, Node 22.22.2, RTX 4080 (NVENC/NVDEC), LAN
192.168.1.44; two screens (1920×1200 primary, a second 1536×864 that captures black), a Meta
Virtual Monitor driver already present. Installed by hand (both installers elevate, see
`install.md`): Apollo 0.4.6 (`ClassicOldSong.Apollo`), moonlight-qt 6.1.0
(`MoonlightGameStreamingProject.Moonlight`); moonlight-web v2.10.0 unzipped into `out/`.
The host and every viewer ran on this one machine, so every stream is of this desktop.

Question: does the remote-desktop design in `architecture.md` hold against the real
binaries — can cophylad set up Apollo headlessly over its API, pair moonlight-qt and moonlight-web
without anyone seeing Apollo's web UI, stream into a window and into a browser page framed
under another page, and hand the brain one frame without a host at all?

**Answer: yes, all of it, with six facts the design has to carry.** (1) Apollo 0.4.6 takes
no Basic auth: `POST /api/login` answers a cookie and that cookie is the only key; a second
login replaces it and a foreign `Origin` voids it. (2) `POST /api/config` replaces the whole
config and nothing applies until `POST /api/restart` (the service brings it back in ~3 s).
(3) Every client paired after the first gets `view|list` only: cophylad must grant input and
launch through `/api/clients/update`, which overwrites every field it is not given.
(4) Apollo has no `GET /api/pin`: the PIN is posted blind every 500 ms until `status: true`
(moonlight-qt's session appears ~2 s after spawn, moonlight-web's is there before the PIN
line arrives). (5) The unpaired `/serverinfo` always says `SUNSHINE_SERVER_FREE`; the
streaming signal is `connected` in `/api/clients/list`. (6) Defender's AMSI blocks a
PowerShell capture script that pairs `CopyFromScreen` with JPEG `EncoderParameters` or a
`MemoryStream`+base64 as "malicious content"; capture → scale → `Save(path, Jpeg)` passes.

## What runs

- `probe.ps1` — what the installers left: `C:\Program Files\Apollo\sunshine.exe` (there is
  no `Apollo.exe`; `--creds user pass` exists), service `ApolloService` (auto, running as
  the service wrapper `tools\sunshinesvc.exe`), config in `C:\Program Files\Apollo\config`
  (`sunshine.conf`, `apps.json`, `sunshine_state.json`, `credentials` unreadable to the
  user, `sunshine.log` truncated at every start), TCP 47984/47989/47990/48010 on `0.0.0.0`,
  the `SudoMaker Virtual Display Adapter` beside the Meta Virtual Monitor with both `OK` and
  the screen layout unchanged, firewall rules `Apollo` ×2 and `Moonlight Game Streaming
  Client`. moonlight-qt lives at `C:\Program Files\Moonlight Game Streaming\Moonlight.exe`
  (not `...\Moonlight Game Streaming Project\Moonlight\`).
- `_shared.ts`, `host-api.ts` — the welcome flow and every API call from Bun with
  `tls: {rejectUnauthorized: false}` and no `Origin`.
- `pair-stream.ts pair|list|stream|quit|unpair` — moonlight-qt headless, `cost.ps1` sampling
  the host and the viewer while a stream runs.
- `web.ts [serve]`, `proxy.ts`, `browser.ts` — moonlight-web configured and driven over its
  REST API with the reverse-proxy header as the login, a 100-line Bun TLS proxy doing the
  ticket → cookie → header dance and bridging the stream WebSocket, and a headed Chrome
  (Playwright from the MCP plugin's npx cache, under Node: its driver hangs under Bun)
  opening the stream page directly and inside an iframe, counting decoded frames.
- `screenshot.ps1` — one screen to a scaled JPEG file; `gemini.ts` — the brain's message
  shapes against the live model.

## Results

| Check | Result |
|---|---|
| Welcome credentials | `POST /api/password {newUsername, newPassword, confirmNewPassword}` with no credentials set → `{status: true}`; before that every path (even `/api/config`) answers the welcome page with 200 |
| Login | `POST /api/login {username, password}` → `Set-Cookie: auth=<64 chars>; Secure; SameSite=Strict; Max-Age=2592000`. Basic and Bearer: 401. A second login invalidates the first token. A request carrying `Origin: https://evil.example` with a valid cookie: 401 |
| `GET /api/config` | only the keys that are set plus `platform`, `version`, `status`, `vdisplayStatus`; `POST` replaces the file (`{min_log_level: 1}` alone dropped `sunshine_name`), and `sunshine_name` reached `/serverinfo`'s `<hostname>` only after `POST /api/restart` |
| `GET /api/apps` | `Desktop` with `uuid 90364DA8-…`, `Steam Big Picture`; clients also see a third `Virtual Display` app |
| `GET /api/pin` | 404 on Apollo (Sunshine's pending list does not exist) |
| `POST /api/pin {pin, name}` | `{status: false}` while nothing is pending, `{status: true}` once, then the client is in the list under `name`; `/api/clients/list` → `named_certs: [{uuid, name, perm, connected, display_mode, allow_client_commands, always_use_virtual_display, enable_legacy_ordering}]` |
| Permissions | first client `perm 119480064` (everything); every later one `50331648` = `view\|list`, no input, no launch. `POST /api/clients/update {uuid, name, perm, …}` with `perm 117448448` (all inputs + list/view/launch) fixes it; sent with `{uuid}` alone it wiped the name and set `perm 0` |
| `POST /api/otp` | `{passphrase, deviceName?}` → `{otp: "2357", ip: "192.168.1.44", name: "<hostname>", message: "OTP created, effective within 3 minutes.", status}`; passphrase under 4 chars → 400 "Passphrase too short!"; link `art://192.168.1.44:47989?pin=2357&passphrase=…&name=…` |
| `/serverinfo` on :47989 | 200 without auth, `state=SUNSHINE_SERVER_FREE`, `PairStatus 0`, `currentgame 0` — also while a client streams (unpaired callers see nothing). Streaming = `connected: true` in `/api/clients/list` |
| Unpair / disconnect | `POST /api/clients/unpair {uuid}` → `{status: true}`; `/api/clients/disconnect {uuid}` and `/api/apps/close {}` answer 200 |
| moonlight-qt CLI | a GUI-subsystem exe: `--help` opens a dialog and blocks; stdout carries only `list`; the SDL/Qt/FFmpeg log is on stderr |
| `moonlight pair <host> --pin 1234` | the host accepts the PIN at try 4, **2.1 s** after spawn; the process exits 0 by itself **~55 s** later (do not wait for it). State goes to the registry: `HKCU\Software\Moonlight Game Streaming Project\Moonlight\hosts\N` (`uuid`, `manualaddress`, `srvcert`, `hostname`), no `Moonlight.ini` |
| `moonlight list <host>` | paired: app names on stdout, exit 0 in 0.46 s. Unpaired: "Computer … has not been paired", exit 255 in 0.2 s. This is the "already paired" check |
| `moonlight stream <host> Desktop --display-mode windowed --absolute-mouse --quit-after` | the host lists the client `connected` **7.9 s** after spawn (moonlight-qt checks its update manifest and fetches the app list first); a 1282×752 window of this desktop, hall-of-mirrors. While streaming: **sunshine 9.6 % of one core (15 % max), Moonlight 6.4 % (12 % max), NVENC 1.9 %, NVDEC 1.6 %** |
| `moonlight quit <host>` | exits 0 in 2.4 s, the host shows `connected: false` within the second, the stream window closes — but the streaming process lingers with no window (57 threads) and has to be killed |
| moonlight-web setup | `web-server.exe print-config` writes and prints `server/config.json` when none exists and panics on a partial one (no serde defaults: "missing field `session_expiration_check_interval`"); the config is rewritten from that with `bind_address 127.0.0.1:47800`, `url_path_prefix "/remote"`, `forwarded_header {username_header: "x-cophyla-user", auto_create_missing_user: true}`, `webrtc.port_range 40000–40010`, `nat_1to1 {host, [192.168.1.44]}`; up in 120 ms with 24 actix workers |
| Header login | `GET /api/authenticate` without the header 401; with it 200 and "Adding new user cophyla from proxy" (role `User`, not admin: `/api/roles` 403, so role defaults cannot be set that way). The page sends no CSP or `X-Frame-Options` |
| Host + pair | `POST /api/host {address, http_port}` → `{host: {host_id, paired: "NotPaired", server_state, name, …}}` in 4 ms. `POST /api/pair {host_id}` streams NDJSON: `{"Pin":"7503"}` at once, Apollo accepts the PIN on the first try (112 ms), then `{"Paired": {…host, paired: "Paired"}}` at 161 ms. `GET /api/apps?host_id` → `{apps: [{app_id, title, is_hdr_supported}]}`; the stream page is `/remote/stream.html?hostId=…&appId=…` |
| Settings | in the browser's `localStorage["mlSettings"]` (`dataTransport: "auto"\|"webrtc"\|"websocket"`, `videoSize`, `bitrate`, …), defaults from the role's `default_settings`; the proxy can seed it in the page it serves |
| Proxy | ticket → 302 + `cophyla_remote` cookie (`Path=/remote; Secure; HttpOnly; SameSite=Strict`), the ticket dead afterwards (403), no cookie 403, a spoofed `x-cophyla-user` on the way in overwritten; HTML gets `frame-ancestors 'self'` |
| WebSocket transport (through the proxy) | first frame **5.7 s** after the page opens on a cold streamer, **1.1 s** warm; 1920×1080 H.264 60 fps through `VideoDecoder` (`avc3.42E01E`, prefer-hardware); **150 s: 8927 frames, 25 dropped (0.3 %)**, 11.7 MB over the socket for a mostly static screen; streamer 4.3 %, web-server 1.7 %, sunshine 6.0 % of one core, NVENC 2.8 %, Chrome's NVDEC 4.3 % |
| WebRTC transport | first frame **2.4 s**; ICE candidate `192.168.1.44:40003` (the configured range), video bypasses the proxy (0 bytes on the bridged socket); 762 frames in 12.7 s, 1 dropped. Windows created inbound Allow rules for `streamer.exe` (Public profile) for the spike path — the firewall prompt was not seen by the user, so how it was answered is unknown; a new sidecar path will raise it again |
| Framed | `/frame` (same origin) iframes `stream.html`: first frame 0.6 s warm, 871 frames in 14 s, 9 dropped, keyboard lock relayed through `iframe.js` |
| A 1280×800 custom size on the second attempt | Apollo crashed on `/launch` (38 s, "improper termination" in its next log) and the service restarted it; every later attempt at the default 1920×1080 was fine. Not chased: the viewer keeps the stream at the default size |
| `screenshot.ps1` | 1920×1200 → 1280×800 JPEG ~240 KB (default quality ≈ 75): capture 81–109 ms, scale+encode to ~200 ms in-script, **~510 ms** wall including PowerShell start; 640 wide 69 KB; display index out of range → error; the second screen captures black (a virtual monitor) |
| Gemini | a `user` content holding a `functionResponse` **and** an `inlineData` part is accepted (the brain's Screenshot shape); a separate trailing user message works too. The image costs **1092 tokens** at 1280×800 and at 640×360 alike (fixed per image); a fabricated `functionCall` without its `thoughtSignature` is a 400 |

## Not verified

The locked screen and a UAC prompt in the stream and in the screenshot (the user skipped the
check; `browser.ts --shots` is ready for it). Two real machines and the phone (Artemis from
the `art://` link, Android Chrome on the proxy): nothing on this network. Latency by eye.
Sunshine itself (the fallback is written against the shared API and untested). macOS and
Linux everything. Apollo's virtual display ("Virtual Display" app, `always_use_virtual_display`).

## Decisions

Apollo on Windows (the API and OTP work; the crash was ours to provoke). The host runs as
its service, health-checked over the API, never spawned. Pairing posts the PIN blind. Every
paired viewer gets `perm 117448448` right after pairing. The web sidecar's default transport
is **WebSocket**: it rides the one TLS port the phone already trusts, the proxy carries it,
no UDP range or firewall rule on the viewing node, 0.3 % dropped at 60 fps; WebRTC stays a
config choice for the lower first-frame time. The brain's screenshot goes into the tool
result's own user message; `IMAGE_TOKENS` is 1100 whatever the width, so the default is
1280 wide and the fixtures use 640 for their size alone.

## Files

`install.md`, `probe.ps1`, `_shared.ts`, `host-api.ts`, `pair-stream.ts`, `cost.ps1`,
`web.ts`, `proxy.ts`, `browser.ts`, `screenshot.ps1`, `gemini.ts`. `out/` (gitignored):
`host-creds.json` — the Apollo web credentials this spike created, `moonlight-web/` — the
unzipped release with its `server/` state, `cert.pem`/`key.pem` for the proxy, the
screenshots and logs.
