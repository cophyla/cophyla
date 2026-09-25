// The srcdoc fallback: one document from a view's files, with the entry's stylesheets and
// scripts inlined under a nonce and images turned into data URLs.

import { describe, expect, test } from "bun:test";
import type { ViewContent } from "@cophyla/protocol";
import { inlineView } from "../host/inliner.ts";

const content: ViewContent = {
  id: "v",
  version: "1",
  files: [
    { path: "index.html", mime: "text/html", text: '<!doctype html><html><head><link rel="stylesheet" href="view.css"><link rel="icon" href="x.ico"></head><body><img src="img/icon.png" alt=""><script type="module" src="./view.ts"></script><script src="https://cdn.example/x.js"></script></body></html>' },
    { path: "view.css", mime: "text/css", text: "body { color: red } /* </style> */" },
    { path: "view.ts", mime: "text/javascript", text: 'console.log("</script>");' },
    { path: "img/icon.png", mime: "image/png", base64: "iVBORw0KGgo=" },
  ],
};

describe("inliner", () => {
  test("inlines the entry's own stylesheet and module script under the nonce, keeps foreign references", () => {
    const html = inlineView(content, "index.html", { nonce: "n0nce" });
    expect(html).toContain('<style nonce="n0nce">body { color: red } /* <\\/style> */</style>');
    expect(html).toContain('<script type="module" nonce="n0nce">console.log("<\\/script>");</script>');
    expect(html).toContain('<script src="https://cdn.example/x.js"></script>');
    expect(html).toContain('<link rel="icon" href="x.ico">');
    expect(html).not.toContain('href="view.css"');
    expect(html).not.toContain('src="./view.ts"');
  });

  test("images become data URLs", () => {
    const html = inlineView(content, "index.html");
    expect(html).toContain('<img src="data:image/png;base64,iVBORw0KGgo=" alt="">');
    expect(html).not.toContain('nonce=');
  });

  test("the entry must be a text file of the view", () => {
    expect(() => inlineView(content, "missing.html")).toThrow(/entry missing.html/);
    expect(() => inlineView(content, "img/icon.png")).toThrow(/entry img\/icon.png/);
  });

  test("references resolve relative to the entry's directory", () => {
    const nested: ViewContent = {
      id: "v",
      version: "1",
      files: [
        { path: "pages/index.html", mime: "text/html", text: '<link rel="stylesheet" href="../shared/a.css"><script src="b.ts"></script>' },
        { path: "shared/a.css", mime: "text/css", text: "a{}" },
        { path: "pages/b.ts", mime: "text/javascript", text: "b()" },
      ],
    };
    const html = inlineView(nested, "pages/index.html");
    expect(html).toBe("<style>a{}</style><script>b()</script>");
  });
});
