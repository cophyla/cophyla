# @cophyla/relay

The end-to-end layer of a server relay tunnel, and the peer session that opens one.
WebCrypto only and no dependencies, so the daemon, the phone's web view, the fake phone in
the scratch kit and the tests share one implementation. The server never imports it: it
routes ciphertext by peer and reads nothing else.

| File | Holds |
|---|---|
| `src/tunnel.ts` | `ephemeral()` (X25519, or P-256 when asked), `derive(role, self, peerKey, psk, binding)` → `Tunnel`, whose `seal`/`open` are AES-256-GCM records with an implicit sequence per direction; `pskFromHex` (a controller's pairing secret) and `pskFromToken` (a node's token, hashed) |
| `src/session.ts` | `PeerSession`: the phone's `/ws/relay` client — `relay.auth`, `relay.open` with a fresh ephemeral, the derived tunnel, then `send`/`onText` in the inner protocol; `relay.close` from the server ends it with 4409, a record that fails to open with 4403 |
| `src/chunk.ts` | `chunk(record)` and `Reassembler`: a record cut into data-channel messages of 16 KiB at most (`+` while more follow, `=` on the last) and put back together; `test/chunk-vectors.json` is read by cophyla-net's tests too |

A data channel (milestone 16) is keyed the same way, with the kind `direct` and fresh
ephemerals exchanged in its offer: a phone's from its pairing secret, a node link's from the
node token. Each record is sealed first and cut after, so cophylad's helper, which carries the
messages, holds ciphertext only.

## The tunnel

```
shared = ECDH(e_self, E_peer)
k_dir  = HKDF-SHA256(salt = psk, ikm = shared, info = "cophyla-relay/1" | kind | peer | epk_i | epk_r | dir)
record = AES-256-GCM(k_dir, nonce = dirTag(4) | seq(8 BE), aad = nonce, utf8(frame)); on the wire as base64
```

`psk` is the pairing secret for a controller (`RelayAccess.key`, minted at `pair.claim`) or
SHA-256 of the node token for a node. A peer without it derives keys that never open a
record, so the first record fails and the tunnel closes: the server, which forwards the
handshake, learns nothing it could use. Both ends count records per direction, so a record
replayed, reordered or dropped fails to open. No rekeying; a direction closes at 2^32
records; every tunnel gets fresh ephemerals.
