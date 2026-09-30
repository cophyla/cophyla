// The microphone's wave, over the input while the host records an utterance, so the user can
// see they are heard: a small meter in the middle, a row of bars that stay where they are and
// rise and fall as loud as the microphone hears, mirrored about the middle, the middle ones
// reaching highest. It shows while the host says it records (`host.recording`) and draws what
// the host hands over (`host.levels`), each bar as tall as waveclock.ts says. It floats over the
// foot of the pane, so the conversation does not move when it comes and goes.

import { BARS, WaveMeter } from "./waveclock.ts";

/** A bar's width and the gap after it, in CSS pixels; view.css makes the canvas as wide as the row. */
const BAR_PX = 4;
const GAP_PX = 4;
/** The quietest bar is a dot; the loudest leaves this much above and below. */
const MIN_BAR_PX = 2;
const PAD_PX = 5;
/** How long the strip takes to fade away: view.css's transition. */
const FADE_MS = 180;

/** The strip itself: an element to place over the input, shown and hidden by `show`, fed by `push`. */
export class Waves {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private meter = new WaveMeter();
  private on = false;
  private frame?: number;
  private hideTimer?: ReturnType<typeof setTimeout>;
  /** view.css's brand purple and its light ink, read as the strip comes in. */
  private colors = { deep: "#8c52d9", ink: "#c7a3f0" };

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "waves";
    this.el.hidden = true;
    this.el.setAttribute("role", "img");
    this.el.setAttribute("aria-label", "Recording: the microphone's sound");
    const strip = document.createElement("div");
    strip.className = "waves-strip";
    this.canvas = document.createElement("canvas");
    strip.append(this.canvas);
    this.el.append(strip);
  }

  /** Recording started (the strip comes in, its bars at rest) or stopped (it fades, the bars falling back). */
  show(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    clearTimeout(this.hideTimer);
    if (on) {
      this.meter.clear();
      const style = getComputedStyle(this.el);
      this.colors = { deep: style.getPropertyValue("--cophyla").trim() || this.colors.deep, ink: style.getPropertyValue("--cophyla-ink").trim() || this.colors.ink };
      this.el.hidden = false;
      // Shown a frame before it is on, so the fade in runs.
      requestAnimationFrame(() => {
        if (this.on) this.el.dataset["state"] = "on";
      });
      this.run();
      return;
    }
    delete this.el.dataset["state"];
    this.meter.rest();
    this.hideTimer = setTimeout(() => {
      if (this.on) return;
      this.el.hidden = true;
      if (this.frame !== undefined) cancelAnimationFrame(this.frame);
      this.frame = undefined;
      this.meter.clear();
    }, FADE_MS);
  }

  push(levels: readonly number[]): void {
    if (this.on) this.meter.push(levels, performance.now());
  }

  private run(): void {
    if (this.frame !== undefined) return;
    const tick = (): void => {
      this.draw();
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  private draw(): void {
    const canvas = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    // The row in the middle of the canvas, the brand's light ink at its middle, deeper at its ends.
    const span = BARS * BAR_PX + (BARS - 1) * GAP_PX;
    let x = (width - span) / 2;
    const fill = ctx.createLinearGradient(x, 0, x + span, 0);
    fill.addColorStop(0, this.colors.deep);
    fill.addColorStop(0.5, this.colors.ink);
    fill.addColorStop(1, this.colors.deep);
    ctx.fillStyle = fill;
    const mid = height / 2;
    const reach = Math.max(MIN_BAR_PX, mid - PAD_PX);
    for (const level of this.meter.heights(performance.now())) {
      const h = Math.max(MIN_BAR_PX, level * reach);
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") ctx.roundRect(x, mid - h, BAR_PX, h * 2, BAR_PX / 2);
      else ctx.rect(x, mid - h, BAR_PX, h * 2);
      ctx.fill();
      x += BAR_PX + GAP_PX;
    }
  }
}
