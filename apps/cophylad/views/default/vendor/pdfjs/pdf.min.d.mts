// Written here, not copied: the parts of pdf.js 5.7.284 (Apache-2.0) the file viewer uses,
// declared for its type check. The library's own typings are a tree of files, so the view
// declares only these (scripts/vendor-view.ts pins the copies beside this).

export interface PageViewport {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly rotation: number;
}

export interface RenderTask {
  readonly promise: Promise<void>;
  cancel(extraDelay?: number): void;
}

export interface PDFPageProxy {
  readonly pageNumber: number;
  getViewport(params: { scale: number; rotation?: number }): PageViewport;
  render(params: { canvasContext: CanvasRenderingContext2D; viewport: PageViewport; transform?: number[] | null }): RenderTask;
  streamTextContent(params?: { includeMarkedContent?: boolean; disableNormalization?: boolean }): ReadableStream;
  cleanup(): boolean;
}

export interface PDFDocumentProxy {
  readonly numPages: number;
  getPage(pageNumber: number): Promise<PDFPageProxy>;
  destroy(): Promise<void>;
}

export interface PDFDocumentLoadingTask {
  readonly promise: Promise<PDFDocumentProxy>;
  destroy(): Promise<void>;
}

export interface DocumentInitParameters {
  data?: Uint8Array;
  isEvalSupported?: boolean;
  useSystemFonts?: boolean;
  disableFontFace?: boolean;
  useWasm?: boolean;
  verbosity?: number;
}

export function getDocument(src: DocumentInitParameters): PDFDocumentLoadingTask;

export class TextLayer {
  constructor(params: { textContentSource: ReadableStream; container: HTMLElement; viewport: PageViewport });
  render(): Promise<void>;
  cancel(): void;
}

export const VerbosityLevel: { readonly ERRORS: 0; readonly WARNINGS: 1; readonly INFOS: 5 };
export const version: string;
