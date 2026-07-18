import type { Dirent, Stats } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const racedEntry = {
    name: "raced.jsonl",
    isFile: (): boolean => true,
    isDirectory: (): boolean => false,
    isSymbolicLink: (): boolean => false,
  } as Dirent;
  const racedStats = {
    isSymbolicLink: (): boolean => true,
  } as Stats;
  return {
    ...actual,
    existsSync: (path: string): boolean => path === "/virtual-codex" || actual.existsSync(path),
    readdirSync: (path: string, options?: { withFileTypes?: boolean }): Dirent[] | string[] => {
      if (path === "/virtual-codex" && options?.withFileTypes) return [racedEntry];
      return actual.readdirSync(path, options as { withFileTypes: true });
    },
    lstatSync: (path: string): Stats => path === "/virtual-codex/raced.jsonl"
      ? racedStats
      : actual.lstatSync(path),
  };
});

import { findCodexSessionFiles } from "../src/codex-transcript.js";

describe("Codex transcript discovery races", () => {
  it("rejects a flat file replaced by a symlink after directory enumeration", () => {
    expect(findCodexSessionFiles("/virtual-codex")).toEqual([]);
  });
});
