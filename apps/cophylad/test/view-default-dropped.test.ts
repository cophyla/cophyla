// Files dropped on the default view from the desktop. In WebView2 the view hands it the files
// with an id, the shell's answer under that id is their paths, and an answer short of a path or
// none at all fails the drop. Elsewhere the view asks its host by the files' names, and an
// answer short of a path, or one that is not paths, fails the drop too. WebView2 wins where the
// frame has it.

import { describe, expect, test } from "bun:test";
import { DroppedPaths, FILES_MESSAGE, webView2 } from "../views/default/dropped.ts";
import type { AskHost, WebView2 } from "../views/default/dropped.ts";

function fake() {
  const posted: { message: unknown; objects: unknown[] }[] = [];
  let hear: ((ev: { data: unknown }) => void) | undefined;
  const webview: WebView2 = {
    postMessageWithAdditionalObjects: (message, objects) => void posted.push({ message, objects: Array.from(objects) }),
    addEventListener: (_type, listener) => void (hear = listener),
  };
  return { webview, posted, answer: (data: unknown) => hear!({ data }) };
}

/** A host that answers with `answer(names)`, keeping what it was asked. */
function host(answer: (names: string[]) => unknown) {
  const asked: string[][] = [];
  const ask: AskHost = async (names) => {
    asked.push(names);
    return answer(names);
  };
  return { ask, asked };
}

const noHost: AskHost = () => Promise.reject(new Error("the host was asked"));

describe("files dropped on the default view, in WebView2", () => {
  test("the files go to WebView2 with an id, and the shell's answer under that id is their paths", async () => {
    const { webview, posted, answer } = fake();
    const dropped = new DroppedPaths(webview, noHost);
    const a = new File(["x"], "a.ts");
    const docs = new File([], "docs");
    const first = dropped.paths([a, docs]);
    const second = dropped.paths([a]);
    expect(posted).toEqual([
      { message: { cophyla: FILES_MESSAGE, id: 1 }, objects: [a, docs] },
      { message: { cophyla: FILES_MESSAGE, id: 2 }, objects: [a] },
    ]);
    answer({ cophyla: FILES_MESSAGE, id: 2, paths: ["C:\\D\\a.ts"] });
    answer({ cophyla: "other", id: 1, paths: ["C:\\elsewhere", "C:\\x"] });
    answer("not an answer");
    answer({ cophyla: FILES_MESSAGE, id: 1, paths: ["C:\\D\\a.ts", "C:\\D\\docs"] });
    expect(await first).toEqual(["C:\\D\\a.ts", "C:\\D\\docs"]);
    expect(await second).toEqual(["C:\\D\\a.ts"]);
  });

  test("an answer short of a path fails the drop, and so does a post WebView2 refuses", async () => {
    const { webview, answer } = fake();
    const dropped = new DroppedPaths(webview, noHost);
    const short = dropped.paths([new File([], "a"), new File([], "b")]);
    answer({ cophyla: FILES_MESSAGE, id: 1, paths: ["C:\\D\\a"] });
    await expect(short).rejects.toThrow("could not say where every file is");
    const refusing = new DroppedPaths(
      {
        ...webview,
        postMessageWithAdditionalObjects: () => {
          throw new Error("not a file");
        },
      },
      noHost,
    );
    await expect(refusing.paths([new File([], "a")])).rejects.toThrow("not a file");
  });

  test("WebView2 is the frame's own only when it can take files", () => {
    expect(webView2({})).toBeUndefined();
    expect(webView2({ chrome: { webview: { postMessage: () => {} } } })).toBeUndefined();
    const { webview } = fake();
    expect(webView2({ chrome: { webview } })).toBe(webview);
  });
});

describe("files dropped on the default view, elsewhere", () => {
  test("the host is asked by the files' names, and its answer is their paths", async () => {
    const { ask, asked } = host(() => ({ paths: ["/home/u/drop me/a.txt", "/home/u/drop me/b c.txt"] }));
    const dropped = new DroppedPaths(undefined, ask);
    expect(await dropped.paths([new File(["x"], "a.txt"), new File([], "b c.txt")])).toEqual(["/home/u/drop me/a.txt", "/home/u/drop me/b c.txt"]);
    expect(asked).toEqual([["a.txt", "b c.txt"]]);
  });

  test("an answer short of a path, one that is not paths, or a refusal fails the drop", async () => {
    const files = [new File([], "a"), new File([], "b")];
    await expect(new DroppedPaths(undefined, host(() => ({ paths: ["/x/a"] })).ask).paths(files)).rejects.toThrow("could not say where every file is");
    for (const odd of [undefined, null, {}, { paths: "/x/a /x/b" }, { paths: ["/x/a", 2] }]) {
      await expect(new DroppedPaths(undefined, host(() => odd).ask).paths(files)).rejects.toThrow("not paths");
    }
    await expect(new DroppedPaths(undefined, () => Promise.reject(new Error("no files were dropped just now"))).paths(files)).rejects.toThrow("no files were dropped");
  });

  test("where the frame has WebView2 the host is never asked", async () => {
    const { webview, posted, answer } = fake();
    const { ask, asked } = host(() => ({ paths: ["/elsewhere"] }));
    const dropped = new DroppedPaths(webview, ask);
    const got = dropped.paths([new File([], "a")]);
    answer({ cophyla: FILES_MESSAGE, id: 1, paths: ["C:\\D\\a"] });
    expect(await got).toEqual(["C:\\D\\a"]);
    expect(posted).toHaveLength(1);
    expect(asked).toEqual([]);
  });
});
