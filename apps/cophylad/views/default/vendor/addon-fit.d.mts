// @xterm/addon-fit 0.11.0, as the default view uses it.

import type { ITerminalAddon, Terminal } from "./xterm.mjs";

export declare class FitAddon implements ITerminalAddon {
  activate(terminal: Terminal): void;
  dispose(): void;
  fit(): void;
  proposeDimensions(): { cols: number; rows: number } | undefined;
}
