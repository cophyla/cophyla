// The smallest view that proves the host is wired: it prints every frame the bridge
// forwards, so a run in a browser shows `host.ready`, the scopes it was given and the
// notifications that reach it. Plain JavaScript, no imports: a fixture, not a product.

const log = document.getElementById("log");
const lines = [];

function note(text, cls) {
  lines.unshift(`${new Date().toISOString().slice(11, 19)} ${text}`);
  lines.length = Math.min(lines.length, 40);
  log.textContent = lines.join("\n");
  if (cls) log.classList.add(cls);
}

window.addEventListener("message", (ev) => {
  const data = ev.data;
  if (!data || data.cophyla !== "cophyla.view/1") return;
  const frame = data.frame;
  if (frame.method === "host.ready") {
    note(`host.ready — client ${frame.params.client.id}, scopes ${frame.params.scopes.join(", ")}`);
    return;
  }
  if (frame.method === "host.state") {
    note(`host.state connected=${frame.params.connected}`);
    return;
  }
  if (frame.method === "chat.message") {
    const text = (frame.params.message.content || []).map((b) => b.text || "").join(" ");
    note(`chat.message (${frame.params.message.source}) ${text}`, "said");
    return;
  }
  note(`${frame.method ?? "response"} ${JSON.stringify(frame.params ?? frame.result ?? frame.error ?? {}).slice(0, 200)}`);
});

note("loaded");
