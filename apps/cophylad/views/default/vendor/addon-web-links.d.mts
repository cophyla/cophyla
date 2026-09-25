// @xterm/addon-web-links 0.12.0, as the default view uses it.

import type { ITerminalAddon, Terminal } from "./xterm.mjs";

export interface IViewportRange {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

export interface ILinkProviderOptions {
  hover?(event: MouseEvent, text: string, location: IViewportRange): void;
  leave?(event: MouseEvent, text: string): void;
  urlRegex?: RegExp;
}

export declare class WebLinksAddon implements ITerminalAddon {
  constructor(handler?: (event: MouseEvent, uri: string) => void, options?: ILinkProviderOptions);
  activate(terminal: Terminal): void;
  dispose(): void;
}
