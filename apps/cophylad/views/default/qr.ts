// An invite's QR code: the link it holds, as the matrix the vendored encoder (`vendor/uqr.mjs`)
// makes, quiet zone included, and the one path that draws its dark modules. Pure, so the
// tests read it back; render.ts builds the SVG from it, dark on white whatever the view's
// own colours, as elements, never from markup.

import { encode } from "./vendor/uqr.mjs";

/** Modules of white around the code: the quiet zone the standard asks for. */
export const QR_BORDER = 4;

/** The modules of `text`'s code, quiet zone included: rows of dark (true) and light. */
export function qrModules(text: string): boolean[][] {
  return encode(text, { ecc: "M", border: QR_BORDER }).data;
}

/** One path for every dark module: each run of them in a row a single rectangle. */
export function qrPath(modules: boolean[][]): string {
  let d = "";
  modules.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      if (!row[x]) {
        x++;
        continue;
      }
      let run = 1;
      while (row[x + run]) run++;
      d += `M${x} ${y}h${run}v1h-${run}z`;
      x += run;
    }
  });
  return d;
}
