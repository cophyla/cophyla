// Opening the verification URL in the system browser, for the desktop app's login. On
// Windows `start` mangles a URL with `&` in its query, so the shell is bypassed:
// `rundll32 url.dll,FileProtocolHandler` takes the URL whole. Elsewhere `open` / `xdg-open`.

export type Opener = (url: string) => Promise<void>;

export function systemOpener(platform: NodeJS.Platform = process.platform): Opener {
  return async (url) => {
    if (!/^https?:\/\//.test(url)) throw new Error(`refusing to open ${url.slice(0, 40)}: not http(s)`);
    const argv = platform === "win32" ? ["rundll32", "url.dll,FileProtocolHandler", url] : platform === "darwin" ? ["open", url] : ["xdg-open", url];
    const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`${argv[0]} exited ${code}`);
  };
}
