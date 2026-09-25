// Stands in for cophylad: started by the shell, must outlive the window and, per the
// architecture, keep running after the app quits.
import { appendFileSync, mkdirSync } from "node:fs";

const OUT = new URL("./out/", import.meta.url);
mkdirSync(OUT, { recursive: true });
const FILE = new URL("./child.jsonl", OUT);

let n = 0;
setInterval(() => {
  appendFileSync(FILE, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, beat: n++ }) + "\n");
}, 500);

// Don't run forever if the spike is abandoned.
setTimeout(() => process.exit(0), 5 * 60 * 1000);
