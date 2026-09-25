// Two peers in one process, over the machine's own interfaces: does the library load under
// the runtime running this file, open a data channel, and carry a message each way?
//   bun smoke.ts ndc|werift
//   node --experimental-strip-types smoke.ts ndc|werift

const lib = process.argv[2] ?? "ndc";
const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);

if (lib === "ndc") {
  const ndc = await import("node-datachannel");
  console.log(`loaded libdatachannel ${ndc.getLibraryVersion()} at ${ms()} ms`);
  const a = new ndc.PeerConnection("a", { iceServers: [] });
  const b = new ndc.PeerConnection("b", { iceServers: [] });
  a.onLocalDescription((sdp, type) => b.setRemoteDescription(sdp, type));
  a.onLocalCandidate((c, mid) => b.addRemoteCandidate(c, mid));
  b.onLocalDescription((sdp, type) => a.setRemoteDescription(sdp, type));
  b.onLocalCandidate((c, mid) => a.addRemoteCandidate(c, mid));
  b.onDataChannel((dc) => {
    dc.onMessage((m) => {
      console.log(`b got ${JSON.stringify(String(m))} at ${ms()} ms`);
      dc.sendMessage("pong");
    });
  });
  const dc = a.createDataChannel("rpc");
  await new Promise<void>((resolve) => {
    dc.onOpen(() => {
      console.log(`open at ${ms()} ms, pair ${JSON.stringify(a.getSelectedCandidatePair())}`);
      dc.sendMessage("ping");
    });
    dc.onMessage((m) => {
      console.log(`a got ${JSON.stringify(String(m))} at ${ms()} ms, rtt ${a.rtt()} ms`);
      resolve();
    });
  });
  dc.close();
  a.close();
  b.close();
  ndc.cleanup();
} else {
  const { RTCPeerConnection } = await import("werift");
  console.log(`loaded werift at ${ms()} ms`);
  const a = new RTCPeerConnection({});
  const b = new RTCPeerConnection({});
  a.onicecandidate = ({ candidate }) => candidate && void b.addIceCandidate(candidate);
  b.onicecandidate = ({ candidate }) => candidate && void a.addIceCandidate(candidate);
  b.ondatachannel = ({ channel }) => {
    channel.onmessage = (e) => {
      console.log(`b got ${JSON.stringify(String(e.data))} at ${ms()} ms`);
      channel.send("pong");
    };
  };
  const dc = a.createDataChannel("rpc");
  const done = new Promise<void>((resolve) => {
    dc.onopen = () => {
      console.log(`open at ${ms()} ms`);
      dc.send("ping");
    };
    dc.onmessage = (e) => {
      console.log(`a got ${JSON.stringify(String(e.data))} at ${ms()} ms`);
      resolve();
    };
  });
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription!);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription!);
  await done;
  await a.close();
  await b.close();
}
console.log(`done at ${ms()} ms`);
process.exit(0);
