import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isWorktreeReconciliationFence,
  serializeWorktreeReconciliationFence,
} from "../src/worktree-reconciliation-fence.js";

describe("worktree reconciliation fences", () => {
  let root: string;
  const hash = "a".repeat(64);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lcm-reconciliation-fence-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("serializes and validates exact project fences", () => {
    const path = join(root, "project-fence");
    const content = serializeWorktreeReconciliationFence(hash, "project");
    expect(content).toBe(`${JSON.stringify({ version: 1, hash, kind: "project" })}\n`);
    writeFileSync(path, content);
    expect(isWorktreeReconciliationFence(path, hash, "project")).toBe(true);
    expect(isWorktreeReconciliationFence(path, "b".repeat(64), "project")).toBe(false);

    writeFileSync(path, `${JSON.stringify({ version: 2, hash, kind: "project" })}\n`);
    expect(isWorktreeReconciliationFence(path, hash, "project")).toBe(false);
    writeFileSync(path, "{");
    expect(isWorktreeReconciliationFence(path, hash, "project")).toBe(false);
    writeFileSync(path, "x".repeat(1025));
    expect(isWorktreeReconciliationFence(path, hash, "project")).toBe(false);

    rmSync(path);
    mkdirSync(path);
    expect(isWorktreeReconciliationFence(path, hash, "project")).toBe(false);
    rmSync(path, { recursive: true });
    symlinkSync(join(root, "missing"), path);
    expect(isWorktreeReconciliationFence(path, hash, "project")).toBe(false);
    rmSync(path);
    expect(isWorktreeReconciliationFence(path, hash, "project")).toBe(false);
  });

  it("requires an exact private event-fence directory shape and marker", () => {
    const path = join(root, `${hash}.db`);
    const marker = join(path, "fence.json");
    mkdirSync(path);
    const content = serializeWorktreeReconciliationFence(hash, "events");
    expect(content).toBe(`${JSON.stringify({ version: 1, hash, kind: "events" })}\n`);
    writeFileSync(marker, content);
    expect(isWorktreeReconciliationFence(path, hash, "events")).toBe(true);

    writeFileSync(join(path, "unexpected"), "entry");
    expect(isWorktreeReconciliationFence(path, hash, "events")).toBe(false);
    rmSync(join(path, "unexpected"));
    rmSync(marker);
    writeFileSync(join(path, "wrong-name"), content);
    expect(isWorktreeReconciliationFence(path, hash, "events")).toBe(false);

    rmSync(path, { recursive: true });
    writeFileSync(path, content);
    expect(isWorktreeReconciliationFence(path, hash, "events")).toBe(false);
    rmSync(path);
    const target = join(root, "events-target");
    mkdirSync(target);
    writeFileSync(join(target, "fence.json"), content);
    symlinkSync(target, path, "dir");
    expect(isWorktreeReconciliationFence(path, hash, "events")).toBe(false);
  });

  it.each([
    ["malformed JSON", "{"],
    [
      "wrong hash",
      `${JSON.stringify({ version: 1, hash: "b".repeat(64), kind: "events" })}\n`,
    ],
    [
      "wrong kind",
      `${JSON.stringify({ version: 1, hash, kind: "project" })}\n`,
    ],
    [
      "wrong version",
      `${JSON.stringify({ version: 2, hash, kind: "events" })}\n`,
    ],
  ])("rejects an events marker with %s", (_label, content) => {
    const path = join(root, `${hash}.db`);
    mkdirSync(path);
    writeFileSync(join(path, "fence.json"), content);
    expect(isWorktreeReconciliationFence(path, hash, "events")).toBe(false);
  });

  it("rejects an oversized or symlinked event marker", () => {
    const path = join(root, `${hash}.db`);
    const marker = join(path, "fence.json");
    mkdirSync(path);
    writeFileSync(marker, "x".repeat(1025));
    expect(isWorktreeReconciliationFence(path, hash, "events")).toBe(false);

    rmSync(marker);
    const target = join(root, "marker-target");
    writeFileSync(target, serializeWorktreeReconciliationFence(hash, "events"));
    symlinkSync(target, marker);
    expect(isWorktreeReconciliationFence(path, hash, "events")).toBe(false);
  });
});
