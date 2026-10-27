import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const closeCalls: number[] = [];
let failClose = false;

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    closeSync: (fd: number) => {
      closeCalls.push(fd);
      actual.closeSync(fd);
      if (failClose) {
        failClose = false;
        throw Object.assign(new Error("close failed"), { code: "EIO" });
      }
    },
  };
});

const { parseTranscript } = await import("../src/transcript.js");
const { parseCodexTranscript } = await import("../src/codex-transcript.js");

let dir: string;

beforeEach(() => {
  closeCalls.length = 0;
  failClose = false;
  dir = mkdtempSync(join(tmpdir(), "transcript-close-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

it("parseTranscript keeps the parsed messages when closing the descriptor fails", () => {
  const path = join(dir, "claude.jsonl");
  writeFileSync(path, '{"message":{"role":"user","content":"hello"}}\n');
  failClose = true;
  expect(parseTranscript(path)).toEqual([{ role: "user", content: "hello", tokenCount: 2 }]);
  expect(closeCalls).toHaveLength(1);
});

it("parseCodexTranscript keeps the parsed messages when closing the descriptor fails", () => {
  const path = join(dir, "codex.jsonl");
  writeFileSync(path, '{"type":"response_item","payload":{"type":"message","role":"assistant","content":"hello"}}\n');
  failClose = true;
  expect(parseCodexTranscript(path)).toEqual([{ role: "assistant", content: "hello", tokenCount: 2 }]);
  expect(closeCalls).toHaveLength(1);
});
