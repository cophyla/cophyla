// The part of @xterm/xterm 6.0.0's API the default view uses, for the typecheck; the package's
// own typings declare it as an ambient module, which a relative import cannot use.

export interface ITheme {
  background?: string;
  foreground?: string;
  cursor?: string;
  selectionBackground?: string;
}

export interface ITerminalOptions {
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  scrollback?: number;
  cursorBlink?: boolean;
  allowProposedApi?: boolean;
  disableStdin?: boolean;
  theme?: ITheme;
  linkHandler?: ILinkHandler | null;
}

export interface IBufferCellPosition {
  x: number;
  y: number;
}

export interface IBufferRange {
  start: IBufferCellPosition;
  end: IBufferCellPosition;
}

/** What an OSC 8 hyperlink does when it is clicked, hovered and left. */
export interface ILinkHandler {
  activate(event: MouseEvent, text: string, range: IBufferRange): void;
  hover?(event: MouseEvent, text: string, range: IBufferRange): void;
  leave?(event: MouseEvent, text: string, range: IBufferRange): void;
  allowNonHttpProtocols?: boolean;
}

export interface IFunctionIdentifier {
  prefix?: string;
  intermediates?: string;
  final: string;
}

export interface IParser {
  registerCsiHandler(id: IFunctionIdentifier, callback: (params: (number | number[])[]) => boolean): IDisposable;
  registerOscHandler(ident: number, callback: (data: string) => boolean): IDisposable;
}

export interface IModes {
  readonly mouseTrackingMode: "none" | "x10" | "vt200" | "drag" | "any";
}

export interface IDisposable {
  dispose(): void;
}

export interface ITerminalAddon extends IDisposable {
  activate(terminal: Terminal): void;
}

export declare class Terminal implements IDisposable {
  constructor(options?: ITerminalOptions);
  readonly cols: number;
  readonly rows: number;
  readonly element: HTMLElement | undefined;
  options: ITerminalOptions;
  readonly unicode: { activeVersion: string };
  readonly parser: IParser;
  readonly modes: IModes;
  open(parent: HTMLElement): void;
  write(data: string | Uint8Array, callback?: () => void): void;
  reset(): void;
  resize(cols: number, rows: number): void;
  focus(): void;
  loadAddon(addon: ITerminalAddon): void;
  onData(listener: (data: string) => void): IDisposable;
  input(data: string, wasUserInput?: boolean): void;
  paste(data: string): void;
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
  readonly onSelectionChange: (listener: () => void) => IDisposable;
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
  dispose(): void;
}
