// The page a video or a sound plays in. The view's own policy lets no media in, so it plays in
// the document frame the host serves (docframe.ts), whose policy lets media in from `blob:` and
// runs a page's scripts, reaching nothing: this page is written there in place of the frame's
// own, says it is ready (`{cophylaMediaReady}`), and takes the media from the view: from the URL
// a host that streams serves it on (`{cophylaMedia: {url}}`, which the frame's policy lets in on
// that host alone; media.ts in @cophyla/viewhost), which plays as it comes and seeks as it
// plays, or its bytes read whole (`{cophylaMedia: {parts, type}}`), as a blob. A sound shows its
// name over the bar, where a video shows its picture. Beside the browser's own controls (the
// bar to seek on, the volume, full screen) it has buttons a finger can find: back and forward
// ten seconds, play or pause, and the speed. Keys do the same: Space or K plays and pauses, J
// and L go ten seconds back and forward, the arrows five, Home and End to either end, M mutes and
// F fills the screen; the view hands on the keys pressed while its viewer has the focus
// (`{cophylaMediaKey}`). It tells the view how big and how long the video is once it knows
// (`{cophylaMediaInfo}`), or that it cannot be played, with the browser's code for why (2 the
// network, 4 nothing it can play); Escape pressed in it is the view's.

/** HTML's own escapes, for the name in the page's title. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** Back and forward, in seconds: the buttons and J/L, and the arrows. */
export const SKIP_S = 10;
export const NUDGE_S = 5;

/** The keys the player answers to, as the view hands them on: none with Ctrl, Alt or ⌘ held. */
export const PLAYER_KEYS = [" ", "k", "K", "j", "J", "l", "L", "ArrowLeft", "ArrowRight", "Home", "End", "m", "M", "f", "F"] as const;

const STYLE = `
:root { color-scheme: dark; }
html, body { height: 100%; margin: 0; background: #0b0a0f; color: #e8e4f0; font: 13px system-ui, -apple-system, "Segoe UI", sans-serif; }
body { display: flex; flex-direction: column; }
.stage { position: relative; flex: 1 1 auto; min-height: 0; display: flex; align-items: center; justify-content: center; background: #000; }
video { width: 100%; height: 100%; object-fit: contain; outline: none; }
.stage.sound { flex-direction: column; gap: 18px; padding: 24px; background: #0b0a0f; }
.sound .disc { width: 96px; height: 96px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: #221f2a; border: 1px solid #34303f; color: #b48cf0; font-size: 40px; }
.sound .name { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; color: #e8e4f0; }
audio { width: min(560px, 100%); outline: none; }
.why { position: absolute; left: 16px; right: 16px; margin: 0; text-align: center; color: #e8a28f; }
.bar { flex: 0 0 auto; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 10px; background: #17151d; border-top: 1px solid #2a2733; }
button, select { height: 30px; padding: 0 10px; border: 1px solid #34303f; border-radius: 6px; background: #221f2a; color: inherit; font: inherit; cursor: pointer; }
button:hover, select:hover { background: #2c2836; }
button:focus-visible, select:focus-visible { outline: 2px solid #b48cf0; outline-offset: 1px; }
button:disabled { opacity: 0.45; cursor: default; }
.play { min-width: 46px; font-weight: 600; }
.time { margin-left: 4px; color: #a9a3b8; font-variant-numeric: tabular-nums; }
.grow { flex: 1 1 auto; }
`;

const SCRIPT = `
(function () {
  var SKIP = ${SKIP_S}, NUDGE = ${NUDGE_S};
  var video = document.querySelector("video, audio");
  var what = video.tagName === "AUDIO" ? "audio file" : "video";
  var play = document.querySelector(".play");
  var back = document.querySelector(".back");
  var fwd = document.querySelector(".fwd");
  var time = document.querySelector(".time");
  var why = document.querySelector(".why");
  var rate = document.querySelector(".rate");
  function clock(s) {
    s = Math.max(0, Math.floor(isFinite(s) ? s : 0));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h > 0 ? h + ":" + (m < 10 ? "0" : "") : "") + m + ":" + (x < 10 ? "0" : "") + x;
  }
  function shown() {
    var ready = video.readyState >= 1 && isFinite(video.duration);
    time.textContent = clock(video.currentTime) + " / " + clock(ready ? video.duration : 0);
    var on = !video.paused && !video.ended;
    play.textContent = on ? "\\u275A\\u275A" : "\\u25B6";
    play.title = (on ? "Pause" : "Play") + " (Space or K)";
    play.setAttribute("aria-label", on ? "Pause" : "Play");
    play.disabled = back.disabled = fwd.disabled = !ready;
  }
  function toggle() {
    if (video.paused || video.ended) {
      var p = video.play();
      if (p && p.catch) p.catch(function () {});
    } else video.pause();
  }
  function seek(to) {
    if (!isFinite(video.duration)) return;
    video.currentTime = Math.min(Math.max(0, to), video.duration);
    shown();
  }
  function skip(by) { seek(video.currentTime + by); }
  var KEYS = {
    " ": toggle,
    k: toggle,
    j: function () { skip(-SKIP); },
    l: function () { skip(SKIP); },
    ArrowLeft: function () { skip(-NUDGE); },
    ArrowRight: function () { skip(NUDGE); },
    Home: function () { seek(0); },
    End: function () { seek(video.duration); },
    m: function () { video.muted = !video.muted; },
    f: function () {
      if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
      else if (video.requestFullscreen) video.requestFullscreen().catch(function () {});
    }
  };
  function press(k) {
    var f = KEYS[k.length === 1 ? k.toLowerCase() : k];
    if (!f) return false;
    f();
    return true;
  }
  play.addEventListener("click", toggle);
  back.addEventListener("click", function () { skip(-SKIP); });
  fwd.addEventListener("click", function () { skip(SKIP); });
  rate.addEventListener("change", function () { video.playbackRate = Number(rate.value); });
  ["play", "pause", "ended", "timeupdate", "durationchange", "seeked", "loadeddata"].forEach(function (e) { video.addEventListener(e, shown); });
  video.addEventListener("ratechange", function () { rate.value = String(video.playbackRate); });
  video.addEventListener("loadedmetadata", function () {
    shown();
    parent.postMessage({ cophylaMediaInfo: { width: video.videoWidth, height: video.videoHeight, duration: video.duration } }, "*");
  });
  video.addEventListener("error", function () {
    var code = video.error ? video.error.code : 0;
    why.hidden = false;
    why.textContent = code === 2 ? "This " + what + " stopped coming: the connection to its computer failed." : "This " + what + " cannot be played here: this app does not play the way it is encoded.";
    parent.postMessage({ cophylaMediaInfo: { error: why.textContent, code: code } }, "*");
  });
  addEventListener("keydown", function (ev) {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.key === "Escape") {
      if (!document.fullscreenElement) parent.postMessage({ cophylaMediaKey: "Escape" }, "*");
      return;
    }
    // The speed's own keys pick a speed; a button's Space or Enter presses it.
    if (ev.target === rate) return;
    if ((ev.key === " " || ev.key === "Enter") && ev.target && ev.target.tagName === "BUTTON") return;
    if (press(ev.key)) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  }, true);
  addEventListener("message", function (ev) {
    if (ev.source !== parent || !ev.data) return;
    var d = ev.data;
    if (d.cophylaMedia && !video.src) video.src = typeof d.cophylaMedia.url === "string" ? d.cophylaMedia.url : URL.createObjectURL(new Blob(d.cophylaMedia.parts, { type: d.cophylaMedia.type }));
    else if (typeof d.cophylaMediaKey === "string") press(d.cophylaMediaKey);
  });
  shown();
  parent.postMessage({ cophylaMediaReady: true }, "*");
})();
`;

/** The player page for a video named `name`, or a sound (`audio`), to be written in the document frame. */
export function playerPage(name: string, audio = false): string {
  const stage = audio
    ? `<div class="stage sound"><div class="disc" aria-hidden="true">♪</div><div class="name">${escapeHtml(name)}</div><audio controls preload="auto"></audio><p class="why" hidden></p></div>`
    : `<div class="stage"><video playsinline controls preload="auto"></video><p class="why" hidden></p></div>`;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(name)}</title><style>${STYLE}</style></head>
<body>
${stage}
<div class="bar">
<button type="button" class="back" title="Back ${SKIP_S} seconds (J, or ← for ${NUDGE_S})" aria-label="Back ${SKIP_S} seconds">« ${SKIP_S}s</button>
<button type="button" class="play" title="Play (Space or K)" aria-label="Play">▶</button>
<button type="button" class="fwd" title="Forward ${SKIP_S} seconds (L, or → for ${NUDGE_S})" aria-label="Forward ${SKIP_S} seconds">${SKIP_S}s »</button>
<span class="time">0:00 / 0:00</span><span class="grow"></span>
<select class="rate" title="Speed" aria-label="Speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="1.5">1.5×</option><option value="2">2×</option></select>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
