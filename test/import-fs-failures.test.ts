import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";

const state = vi.hoisted(() => ({ throwNames: new Set<string>(), symlinkNames: new Set<string>() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync(path: import("node:fs").PathLike) {
      const text = String(path);
      const name = text.split(/[\\/]/).pop() ?? "";
      if (state.throwNames.has(name)) throw new Error("stat race");
      const stat = actual.lstatSync(path);
      if (state.symlinkNames.has(name)) {
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
          isSymbolicLink: () => true,
        });
      }
      return stat;
    },
  };
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { findSessionFiles } from "../src/import.js";

describe("findSessionFiles filesystem races", () => {
  const dirs: string[] = [];

  afterEach(() => {
    state.throwNames.clear();
    state.symlinkNames.clear();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function fixture(): string {
    const dir = mkdtempSync(join(tmpdir(), "lcm-import-race-"));
    dirs.push(dir);
    const agents = join(dir, "parent", "subagents");
    mkdirSync(agents, { recursive: true });
    for (const path of [join(dir, "flat.jsonl"), join(agents, "agent.jsonl")]) writeFileSync(path, "");
    return dir;
  }

  it("skips files replaced by symlinks after directory enumeration", () => {
    const dir = fixture();
    state.symlinkNames.add("flat.jsonl");
    state.symlinkNames.add("agent.jsonl");
    expect(findSessionFiles(dir)).toEqual([]);
  });

  it("skips files removed before they can be statted", () => {
    const dir = fixture();
    state.throwNames.add("flat.jsonl");
    state.throwNames.add("agent.jsonl");
    expect(findSessionFiles(dir)).toEqual([]);
  });
});
