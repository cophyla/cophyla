// The model's tokenizer: `tokenizer.json` and `tokenizer_config.json` from the model
// directory, read by `@huggingface/tokenizers` (pure JS; loads under Bun). Sequences are
// truncated to `maxTokens` with the closing [SEP] kept, as the model expects.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Tokenizer } from "@huggingface/tokenizers";

export interface Encoded {
  ids: number[];
}

export interface TextTokenizer {
  encode(text: string, maxTokens: number): Encoded;
}

export const DEFAULT_MAX_TOKENS = 384;

export function loadTokenizer(dir: string): TextTokenizer {
  const tokenizer = new Tokenizer(
    JSON.parse(readFileSync(join(dir, "tokenizer.json"), "utf8")) as object,
    JSON.parse(readFileSync(join(dir, "tokenizer_config.json"), "utf8")) as object,
  );
  const sep = tokenizer.token_to_id("[SEP]");
  return {
    encode(text, maxTokens) {
      const ids = tokenizer.encode(text, { add_special_tokens: true }).ids;
      if (ids.length <= maxTokens) return { ids };
      const cut = ids.slice(0, maxTokens);
      if (sep !== undefined) cut[maxTokens - 1] = sep;
      return { ids: cut };
    },
  };
}
