import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseTranscriptForClient, parseTranscriptTextForClient } from "../src/transcript-provider.js";
for (const client of ["claude", "codex"] as const) {
  for (const text of ["", "{}\nmalformed\n", '{"message":{"role":"user","content":"héllo"}}\n', '{"type":"response_item","payload":{"type":"message","role":"assistant","content":"héllo"}}\n', "null\n"]) {
    it(`${client} preserves pathname parser behavior for ${JSON.stringify(text)}`, () => {
      const dir = mkdtempSync(join(tmpdir(), "transcript-text-"));
      const path = join(dir, "input.jsonl");
      const bytes = Buffer.concat([Buffer.from(text), Buffer.from([0xff])]);
      writeFileSync(path, bytes);
      try {
        if (client === "codex" && text === "null\n") {
          expect(() => parseTranscriptForClient(path, client)).toThrow(TypeError);
          expect(() => parseTranscriptTextForClient(bytes.toString("utf8"), client)).toThrow(TypeError);
        } else {
          expect(parseTranscriptTextForClient(bytes.toString("utf8"), client)).toEqual(parseTranscriptForClient(path, client));
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
}
