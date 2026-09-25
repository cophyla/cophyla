// @xterm/addon-unicode11 0.9.0, as the default view uses it.

import type { ITerminalAddon, Terminal } from "./xterm.mjs";

export declare class Unicode11Addon implements ITerminalAddon {
  activate(terminal: Terminal): void;
  dispose(): void;
}
