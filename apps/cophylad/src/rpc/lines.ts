// A child's output as lines. A pipe hands its data over in chunks that end wherever they end:
// split per chunk, one line becomes two half lines (a helper's one warning was logged as
// thousands of fragments a day), so the part after the last line break is carried to the next
// chunk, and a line that never ends is cut at `maxLine` characters rather than held for ever.

export interface LineSplitter {
  /** Takes a chunk; calls the line handler for each complete line in it. */
  push(chunk: string): void;
  /** The last line, when the stream ended without a line break. */
  end(): void;
}

export function lineSplitter(onLine: (line: string) => void, maxLine = 64 * 1024): LineSplitter {
  let rest = "";
  return {
    push(chunk: string) {
      rest += chunk;
      let at = rest.indexOf("\n");
      while (at >= 0) {
        const line = rest.slice(0, at).replace(/\r$/, "");
        rest = rest.slice(at + 1);
        if (line.trim()) onLine(line);
        at = rest.indexOf("\n");
      }
      if (rest.length > maxLine) {
        onLine(rest.slice(0, maxLine));
        rest = "";
      }
    },
    end() {
      const line = rest.replace(/\r$/, "");
      rest = "";
      if (line.trim()) onLine(line);
    },
  };
}
