// Spike 14: does Gemini accept a user content that mixes a functionResponse (the Screenshot
// tool's result) with an inlineData image part, or must the image be its own trailing user
// message? Also the token cost of a 1280-wide and a 640-wide JPEG.
//
//   GEMINI_KEY=... bun run spikes/14-remote/gemini.ts [out/d0.jpg]
//
// The key is read from the environment or the m9 scratch config (never written here).
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.8-flash";
const BASE = "https://generativelanguage.googleapis.com";
const key =
  process.env.GEMINI_KEY ??
  /api_key\s*=\s*"([^"]+)"/.exec(readFileSync("C:/D/scratch-m9/primary/config.toml", "utf8"))?.[1];
if (!key) throw new Error("no key");

const image = process.argv[2] ?? join(import.meta.dir, "out", "d0.jpg");
const b64 = Buffer.from(readFileSync(image)).toString("base64");
console.log(`${image}: ${b64.length} base64 chars`);

async function complete(label: string, contents: unknown, tools?: unknown) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key! },
    body: JSON.stringify({
      contents,
      ...(tools ? { tools } : {}),
      generationConfig: { maxOutputTokens: 300, thinkingConfig: { thinkingBudget: 0 } },
    }),
  });
  const text = await res.text();
  const ms = Math.round(performance.now() - t0);
  if (!res.ok) {
    console.log(`${label}: ${res.status} (${ms} ms) ${text.slice(0, 300)}`);
    return;
  }
  const j = JSON.parse(text);
  const out = j.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? JSON.stringify(p)).join(" ") ?? "";
  const u = j.usageMetadata;
  console.log(`${label}: ${res.status} (${ms} ms) prompt=${u?.promptTokenCount} (${JSON.stringify(u?.promptTokensDetails)}) out=${u?.candidatesTokenCount}\n  ${out.replace(/\s+/g, " ").slice(0, 300)}`);
}

const tools = [{ functionDeclarations: [{ name: "screenshot", description: "Take a screenshot of a node's screen", parameters: { type: "object", properties: { node: { type: "string" } } } }] }];
const ask = { role: "user", parts: [{ text: "What is on the second machine's screen? Use the screenshot tool, then describe it in two sentences." }] };
// A fabricated functionCall is refused ("missing a thought_signature"), so take the model's own.
const first = await fetch(`${BASE}/v1beta/models/${MODEL}:generateContent`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-goog-api-key": key! },
  body: JSON.stringify({ contents: [ask], tools, generationConfig: { thinkingConfig: { thinkingBudget: 0 } } }),
}).then((r) => r.json());
const callParts = first.candidates?.[0]?.content?.parts;
console.log("model's call:", JSON.stringify(callParts)?.slice(0, 200));
const call = { role: "model", parts: callParts };

// A: functionResponse and inlineData in one user content (the brain's Screenshot shape)
await complete("A mixed functionResponse+inlineData", [
  ask, call,
  { role: "user", parts: [
    { functionResponse: { name: "screenshot", response: { result: "screenshot of second (1280×800, display 0)" } } },
    { inlineData: { mimeType: "image/jpeg", data: b64 } },
  ] },
], tools);

// B: the image as its own trailing user message
await complete("B separate trailing user message", [
  ask, call,
  { role: "user", parts: [{ functionResponse: { name: "screenshot", response: { result: "screenshot of second (1280×800, display 0)" } } }] },
  { role: "user", parts: [{ inlineData: { mimeType: "image/jpeg", data: b64 } }, { text: "(the screenshot)" }] },
], tools);

// C: image alone, for the token count
await complete("C image alone", [{ role: "user", parts: [{ inlineData: { mimeType: "image/jpeg", data: b64 } }, { text: "Describe this screen in one sentence." }] }]);
