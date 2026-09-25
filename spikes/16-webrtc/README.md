# Spike 16: a direct WebRTC path from the phone to the node

Date: 2026-09-24. Windows 11 (build 26200), Bun 1.3.14 (Windows) and 1.4.2 (WSL Ubuntu),
Node 22.22.2, headless Chromium 151 (Playwright's `chromium_headless_shell-1234`),
`node-datachannel` 0.33.4 (libdatachannel 0.24.5), `werift` 0.24.4.

Two questions decide whether the link gets a `p2p` transport beside `lan` and `relay`, with
offer, answer and candidates sent through the relay tunnel. The first is whether cophylad can
hold a WebRTC data channel under Bun, and at what cost. The second is how often a phone
reaches a home node directly.

**Verdict: yes to the first; to the second, "from some networks".**
- libdatachannel runs under Bun on Windows and Linux. It is fast and cheap:
  - an idle connection costs 0.1 % of one core;
  - 230 connect/close cycles leak nothing;
  - a changed DTLS fingerprint fails the connection from either side.
- werift, the pure-TypeScript library, is too slow to use.
- A phone reached this node directly from a NAT that keeps its ports. It also reached it
  from a sequential symmetric NAT once the node predicted the next ports: 3 of 3 across
  two phones. There the round trip was 10–17.5 ms against ~260 ms through the relay.
- A phone did not reach it from the mobile carrier, 0 of 5, prediction included. That NAT
  gives random ports from more than one public IP.
- So a direct path is an upgrade, not a replacement: the relay (or TURN) stays for networks
  like that carrier.
- The relay server is ~125 ms from here. The direct path saves at least that on every round
  trip.

## What is here

- **`peer.ts`:** one answering peer over either library, the node's side.
- **`node.ts`:** the node. It serves the page, signals over a WebSocket, and answers the
  bench over the data channel: echo, bulk, message bursts, steady rates, idle. Each phase
  carries its own CPU and RSS. `--only host|srflx` cuts candidates to one type in both
  directions.
- **`page.html`:** the offering side, in a browser or on the phone. Modes:
  - `bench`;
  - `steady`;
  - `cycles`;
  - `nat`: the mapping behaviour off srflx ports, no node needed;
  - `cross`;
  - `?tamper=offer|answer` flips a byte of the DTLS fingerprint.
- **`drive.ts`, `watch.ts`:** run the page in headless Chromium, the Android web view's
  engine. `watch.ts` prints the page's log as it grows.
- **`nat.ts`, `stun.ts`:** a raw STUN client. It covers mapping across servers, RFC 5780
  filtering and port allocation. It also covers IPv6 and UPnP / NAT-PMP / PCP, asked only
  and never set, and the relay server's round trip.
- **`smoke.ts`:** both libraries, two peers in one process.

```
bun install
bun smoke.ts ndc
bun nat.ts
bun node.ts --lib ndc                     # then:
node --experimental-strip-types drive.ts --runs 3
node --experimental-strip-types watch.ts "http://127.0.0.1:4961/" steady 140
node --experimental-strip-types watch.ts "http://127.0.0.1:4961/?n=200" cycles 280
bun node.ts --lib ndc --only srflx        # the router's public address, both ways
```

## Results

| Test | Result |
|---|---|
| Load under Bun | **node-datachannel:**<ul><li>loads in 17 ms on Windows and 27 ms on Linux;</li><li>two in-process peers open a channel in 33 ms.</li></ul>**werift:**<ul><li>loads in 130–229 ms;</li><li>opens in 445–520 ms.</li></ul>Both work on Windows and Linux. |
| Bench, loopback, Chromium ↔ Bun (ndc), 3 runs | <ul><li>Channel open 70–143 ms after `new RTCPeerConnection`.</li><li>RTT p50 0.1–0.3 ms, p95 ≤ 1.7 ms.</li><li>Down 32–67 MB/s, up 15–52 MB/s.</li><li>17–25 k small JSON messages/s (200-byte deltas).</li><li>The node sat at 120–180 % of one core while flooding.</li></ul> |
| Same, node on Linux (WSL), page on Windows, 2 runs | <ul><li>Open 67–78 ms.</li><li>RTT p50 0.3 ms.</li><li>Down 59–68 MB/s, up 23–46 MB/s.</li><li>177–188 k messages/s.</li></ul> |
| werift node, same bench | <ul><li>Open 563 ms.</li><li>Down 21 MB/s.</li><li>**276 messages/s at 99 % of one core, RSS 277 MB.**</li></ul>A burst of session output would take a minute. Its `bufferedAmountLow` subscriptions pile up per call. Out. |
| Idle and steady cost (ndc) | <ul><li>An open, idle connection over 60 s: **0.1 %** of one core.</li><li>A chat-sized text stream: 0.9 %.</li><li>A binary stream: **9.5 %**, at ~1.6 MB/s. Asked 2.5 MB/s in 20 ms ticks, Windows' timer ran it at 31 ms. So ~6 % of a core per MB/s.</li><li>RSS: 80 MB for Bun alone, ~115 MB with a connection.</li></ul> |
| Reconnects | <ul><li>30 cycles (connect, ping, close): open p50 57 ms, max 144 ms.</li><li>200 more: p50 8 ms, p95 71 ms, max 123 ms.</li><li>After all 230, with GC: RSS 103 MB, heap 2 MB. **No leak.**</li></ul> |
| Fingerprint tampering | One hex digit of `a=fingerprint` flipped:<ul><li>in the offer the node takes: libdatachannel fails the connection;</li><li>in the answer Chromium takes: Chromium fails it.</li></ul>Both end in `failed` after 20 s. **With the SDP inside the E2E relay tunnel, the DTLS channel is authenticated by the pairing keys.** |
| srflx only, through the router's public address (hairpin) | <ul><li>Open **291 ms**, STUN gathering included.</li><li>RTT p50 19 ms: the router's hairpin path, ICE's own 6 ms.</li><li>7.6–9.3 MB/s.</li><li>Pair `srflx <home>:10913 ↔ srflx <home>:10953`.</li></ul> |
| Home NAT, mapping | One socket maps to the **same public port for every server**: Google, Cloudflare, Twilio, Nextcloud, sipgate, ekiga and 15 more. That is **endpoint-independent**. Fresh sockets get random ports in 9000–10900, with no port preservation. |
| Home NAT, filtering (RFC 5780) | CHANGE-REQUEST for IP+port and for port only: no answer from any of 5 servers (ekiga, voipgate, nfon, solnet, fitauto). That is **address-and-port-dependent** (port-restricted cone). `bun.exe` has inbound Allow rules for TCP and UDP, so this is the router, not Windows. |
| IPv6, port mapping | <ul><li>No global IPv6 (Windows says `IPv6Connectivity: NoTraffic`).</li><li>No UPnP IGD answers SSDP.</li><li>No NAT-PMP or PCP answer from 192.168.1.1.</li></ul> |
| The relay server | <ul><li>TCP connect to `api.getcophyla.com:443`: 118–129 ms (one 207 ms).</li><li>HTTPS `/healthz` on a warm connection: 126–142 ms.</li><li>The STUN servers: 17–44 ms.</li></ul>A round trip through the relay is the phone's leg to the server **plus** these ~125 ms. |

## What the NAT result means

Hole punching succeeds when each side's packets reach the other's public mapping, and a
port-restricted cone only lets in packets from the exact address and port it sent to.
Against this router:

| Phone's NAT | Direct path |
|---|---|
| endpoint-independent mapping (any filtering) | works: each side sends to the other's srflx, which is the port it will send from |
| endpoint-dependent (symmetric) | fails: the phone's port toward the node is not the one STUN saw, and this router drops it. The relay (or TURN) carries it |
| IPv6 on both | not here: this home has none |

## Phone pass

Run 2026-09-24 through a Cloudflare quick tunnel to `node.ts --stun` on loopback, so the
phone signals over the internet like it would through the relay. Data never goes through
the tunnel. Results are in `out/results-phone.jsonl`; the node's side is in
`out/node-phone.log` and `out/ndc.log`. The real addresses stay in `out/` (gitignored).

**Four networks, not two.** The node (this PC, wired) and the phones' home Wi-Fi turned
out to be **two different ISPs**:
- the PC is on `192.168.1.x` behind ISP A;
- the Wi-Fi is on `192.168.0.x` behind ISP B.

So even at home, every phone ↔ node path crossed the internet. The registries' owners of
the public addresses gave this away.

| Device, network | Its NAT (NAT only: 5 STUN servers × 3 rounds, or the bench's 2) | Direct to the node |
|---|---|---|
| iPhone (iOS 18.7, Safari), **mobile carrier** | **Endpoint-dependent, random ports.** One socket got 4 different ports from 4 servers in every round. A fifth saw it from a second public IP (the carrier pools addresses). | **Failed 5 of 5**, the last with `--predict 12`. The node guessed 24 ports above STUN's; that round's NAT-only run gave 33991–62019. The page gave up at 15 s, the node's ICE at 40 s. |
| iPhone, **home Wi-Fi (ISP B)**, no prediction | **Endpoint-dependent, sequential ports:** 49566, 49567, 49568, 49570, 49569 for five servers. Its first mapping kept the host port (52005 → 52005, then 52006). | **Failed**, 1 of 1. |
| Android 10 (Chrome), **home Wi-Fi with a VPN on** | The VPN exit's NAT kept one port per socket | **Connected**, `srflx ↔ srflx`: ICE 1.0 s, DTLS 1.5 s, SCTP 1.8 s. 193 pings at ~290 ms (the VPN's detour) until the page was reloaded. |
| iPhone, **home Wi-Fi (ISP B), `--predict 12`** | the same; the NAT-only run again gave five consecutive ports per round | **Connected through a predicted port** (+4 over what STUN saw). Open in **530 ms**. **RTT p50 10 ms, p95 39 ms.** 2.7 MB/s down and 3.3 MB/s up. The same phone to the relay server: 137–140 ms. |
| Android, **home Wi-Fi (ISP B), VPN off, `--predict 12`** | the same sequential NAT as the iPhone's | **Connected 2 of 2 through a predicted port.** The pair was `prflx <ISP B>:55391 ↔ srflx <home>:10914`; STUN had seen 55387, and the port used was +4. Channel open in **753 ms** and 276 ms. **RTT p50 17.5 ms, p95 22.5 ms** (ICE's own 12 ms). 4 MB/s down and 2.2 MB/s up, the Wi-Fi line's limit. The same phone to the relay server: **135–140 ms**. |

**Prediction** (`node.ts --predict n`) is a few lines in the node. For every srflx
candidate the page sends, it also adds remote candidates at the next `n` ports on the same
address. A NAT that hands ports out in sequence maps the phone's socket toward the node to
one of them. The node's own checks to that port open its router for it, so the pair comes
up as prflx on the phone's side. It costs the node a few dozen STUN checks. On the
loopback bench it took the open from ~140 ms to ~800 ms once, and to 234 ms after that.
A random-port NAT (the mobile carrier) cannot be predicted this way.

What the table means for this node's networks:
- **A NAT with stable ports:** direct, as expected.
- **A sequential symmetric NAT:** direct with prediction, at a fifteenth of the relay's
  round trip. The relay path is phone → server (~137 ms) + server → node (~125 ms).
- **A random-port NAT with address pooling:** only the relay, a TURN server, a port the
  node maps on its router (UPnP / NAT-PMP, both absent here) or IPv6 on both sides (none
  here).

## What the research says (2026-09-24)

Three web-research passes checked whether this one house generalizes: how often direct works
in the world, what a fallback costs, and the implementation risks. Key numbers, with the
strongest sources:

**How often direct works.**
- The best measurement is the libp2p "punchr" campaign: 4.4 M attempts, 167 countries, data
  from Dec 2022 to Jan 2023. It found **70 % ± 7 %** hole-punch success, on volunteer
  (better than average) networks, without prediction and with no mobile split
  ([arXiv 2510.27500](https://arxiv.org/abs/2510.27500)).
- Tailscale reports "well north of 90 %" direct. That is its own metric, reached with port
  mapping and IPv6 as well. The same post says two phones on cellular networks often need
  its relay ([Oct 2025](https://tailscale.com/blog/nat-traversal-improvements-pt-1)).
- Production WebRTC relayed 18–22 % of calls. That data is from 2015–2017, and 5–9 % of
  calls needed TURN over TCP, so some networks block UDP outright.

**Mobile networks are the hard case.** Richter et al. surveyed carrier-grade NAT in IMC
2016, with data from 2014–16 ([arXiv 1605.05606](https://arxiv.org/abs/1605.05606)):
- CGNAT sits in over 90 % of cellular networks.
- **~40 % of cellular CGNATs are symmetric.**
- Port allocation on cellular is **45 % random** and 26 % sequential.
- 21 % of CGNATs hand out addresses from a pool.

This spike's mobile carrier (random ports, a pool of addresses) is common, not unusual. No
newer broad survey exists, and nobody publishes a phone-on-cellular → home-computer
success rate.

**Levers beyond plain ICE:**
- **IPv6 on both ends:** APNIC puts 44 % of the world on IPv6. The US, India, Germany and
  France are at 60–85 % (T-Mobile, Verizon and Jio at 95–97 %). Most of the Balkans is
  under 10 %. No clean success rate for direct IPv6 was found, and libp2p saw unexplained
  low IPv6 success.
- **A port mapping on the node's router** (UPnP, NAT-PMP, PCP):
  - It makes the node reachable from any phone NAT, random ones included.
  - UPnP answered in ~35–40 % of homes, from 2011–2015 data.
  - In 17 % of those, the router was itself behind a CGNAT, so the mapping was useless.
  - Carriers essentially never offer PCP.
- **Port prediction:** RFC 5128 calls it fragile under load, and no field success rate is
  published.
  - Sequential allocators are a minority, 22–26 %.
  - Tailscale's "birthday" method (256 ports on the hard side, 1,024 probes) is not known
    to be shipped. It fails when a carrier pools addresses. A web view cannot open hundreds
    of sockets, and the traffic looks like a port scan.
  - A full sweep of one address (~32 k ports here) has the same problems.

**The fallback.**
- **Relay latency:** a relayed round trip is phone → relay + relay → node. That is ~260 ms
  with today's single server. ITU-T G.114 allows 150 ms one-way for transparent voice.
  Remote desktop tolerates ~80–150 ms round trip. The WebSocket relay is also TCP, so one
  lost packet stalls everything behind it.
- **Managed TURN:**
  - **Cloudflare Realtime TURN:** $0.05/GB, the first 1,000 GB a month free, anycast in
    ~330 cities, TURN over TLS on 443, credentials that expire. No region pinning, not in
    China.
  - Twilio is $0.40–0.80/GB in 9 regions. Metered offers region pinning from $99/month.
- **Self-hosted TURN** takes about 5–9 regions to match that reach. The servers have a
  history of SSRF and open-relay problems (coturn CVE-2020-26262, CVE-2026-27624).
- **Cost:** 10 Mbps of remote desktop relayed is ~4.5 GB/h, about $0.23/h on Cloudflare.
  Voice costs next to nothing.
- **What others do:**
  - Tailscale starts on its relay and upgrades to direct.
  - Syncthing keeps retrying direct while on a relay.
  - Chrome Remote Desktop, RustDesk, TeamViewer (70 % direct, 2017) and Jump Desktop try
    direct first and fall back to their relays.
  - Moonlight/Sunshine have no relay at all.

**Implementation risks found:**
- **libjuice** has no ICE restart ([#545](https://github.com/paullouisageneau/libdatachannel/issues/545),
  open since 2022). It has no TURN over TCP/TLS either (UDP only). A network change
  therefore means a new PeerConnection. It does implement consent freshness.
- **node-datachannel** is actively maintained: 0.33.4 fixed a DTLS race that hit ~1 in 130
  handshakes. Some issues are still open: #366 (exit hangs), #375 (a message sent just
  before close is lost), #211 (a remote close is not reported). Call `cleanup()` at exit.
  Bun fixed N-API threadsafe-function crashes after 1.3.14.
- **macOS:**
  - The `darwin-x64` prebuild targets macOS 26 and is unsigned, so build our own with a
    deployment target and sign it.
  - macOS 15+ Local Network privacy applies to the node's UDP to LAN addresses. A launchd
    agent needs `AssociatedBundleIdentifiers`, and the same applies to the LAN listener
    today.
- **Windows Firewall:**
  - A per-user installer cannot add rules.
  - Rules match the resolved exe path. `bun.exe` sits under a versioned path, so expect a
    prompt per update (a symlink does not help).
  - Replies to our own outbound UDP need no rule (ALE flows, 60 s idle), and Microsoft
    says calls work even after Cancel.
  - Unsolicited inbound is dropped: peer-reflexive checks and the LAN host candidate.
  - Whether a UDP bind alone raises the prompt is undocumented. This spike's `bun.exe`
    already had Allow rules, so the Windows results here say nothing about a clean install.
- **Mobile:**
  - WKWebView traffic needs no Local Network permission.
  - iOS suspends the app and Android freezes cached apps after 10 s. The link must rebuild
    the PeerConnection on return and keep the relay live meanwhile.
- **Security:**
  - Keep the SDP inside the E2E tunnel, and never set `disableFingerprintVerification`.
  - Keep cophylad's own E2E protocol on top of the data channel.
  - Drop VPN and virtual-interface candidates.
  - Prefer our own STUN server, since public ones learn the node's IP.
  - DTLS is 1.2 today; 1.3 comes with OpenSSL 4.1.

## Findings beyond the questions

- **Packaging:** `stage-platform.ts` installs cophylad's dependencies with `--omit=optional`.
  node-datachannel's binary is an optional platform package
  (`@node-datachannel/win32-x64-msvc`, 7.5 MB; `linux-x64-gnu` and `-musl` on Linux), so it
  would be dropped. It needs the treatment `sherpaBinaryPackage` gives sherpa-onnx. On
  macOS the `.node` is a Mach-O, so the existing rule signs it. The license is MPL-2.0
  (libdatachannel and the binding), file-level, compatible with shipping beside Apache-2.0.
- **The firewall:** a default install binds nothing on a wildcard address; `[controller]`
  is off. ICE's UDP sockets would be the first such bind. Spike 14 saw Windows create
  inbound rules for moonlight-web's `streamer.exe`, which binds UDP, so a prompt for
  `bun.exe` is likely. `bun.exe` lives under a versioned path, so the prompt could return
  with each platform update. The direct path should need no inbound rule, since each side
  sends first. Neither is checked here: it would put a dialog on the desktop in use.
- **moonlight-web** has `webrtc.ice_servers` and `ice_server_script` in its config. Its
  streamer can gather srflx candidates for a stream across networks. The stream page's
  signalling socket still has to cross the tunnel.
- **A send on a closed channel throws.** libdatachannel throws synchronously
  (`sendMessagBinary() called on destroyed channel`), and uncaught it ended Bun. A phone
  that left mid-transfer took the node down once. cophylad's transport must check `isOpen()`
  and catch.
- The Playwright in the npx cache moved to a build whose browsers are not installed. The
  drivers point at `chromium_headless_shell-1234`.

## Not verified

- More carriers and networks: one mobile carrier and one Wi-Fi ISP so far.
- The node and a phone on one LAN: the LAN transport already covers it.
- The firewall prompt and whether the direct path needs a rule.
- macOS (no Mac).
- TURN.
- An ICE restart when the phone changes networks.
