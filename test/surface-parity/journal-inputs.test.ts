import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveGitProjectAnchor } from "../../src/git-project.js";
import { createGitFixture, createLinkedWorktreeFixture } from "./git-fixture.mjs";
import { assertJournalInputTransition, captureCodexCatalogue, captureJournalInputs, discoveryForJournal } from "./journal-inputs.mjs";

const homes: string[] = [];
const hash = (path: string) => createHash("sha256").update(path).digest("hex");
const fingerprint = (value: unknown) => hash(JSON.stringify(value));
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "journal-inputs-"));
  homes.push(home);
  const target = createGitFixture(join(home, "target"));
  return { home, target };
}
const options = (paths: string[]) => ({ paths, resolveGitProjectAnchor });
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe("independent journal discovery inputs", () => {
  it("derives exact map rows, alias order, remote and fingerprints without reading journals", () => {
    const { home, target } = fixture();
    const missing = join(home, "old-alias");
    const map = { [hash(target)]: { canonical: target, aliases: [missing], remoteProjectId: "binding" } };
    const input = captureJournalInputs(home, map, options([target]));
    const result = discoveryForJournal(input, map, target);
    const observations = [[target, "git", join(target, ".git"), target], [missing, "missing"]]
      .sort(([a], [b]) => a.localeCompare(b));
    expect(result).toEqual({ aliases: [target, missing], sourceHashes: [], remoteProjectId: "binding",
      discovery: { mapFingerprint: fingerprint([[hash(target), target, [missing], "binding", observations]]),
        codexFingerprint: fingerprint({ catalogue: [], complete: true }), complete: true } });
    expect(Object.isFrozen(input.observations[target])).toBe(true);
    expect(() => discoveryForJournal(input, {}, target)).toThrow("unvalidated-map-prefix");
  });

  it.each(["missing", "permission", "signal", "timeout"])("handles actual Git executable %s under isolated PATH", kind => {
    const { home, target } = fixture();
    const emptyPath = join(home, "empty-path"); mkdirSync(emptyPath, { mode: 0o700 });
    if (kind !== "missing") writeFileSync(join(emptyPath, "git"), kind === "timeout" ? "#!/bin/sh\n/bin/sleep 5\n"
      : kind === "signal" ? "#!/bin/sh\nkill -TERM $$\n" : "#!/bin/sh\nexit 2\n", { mode: kind === "permission" ? 0o600 : 0o700 });
    // Resolve the actual fixture anchor independently before giving the child
    // an empty PATH. The child's real execFileSync must report spawn absence.
    const anchor = resolveGitProjectAnchor(target);
    const input = { home, target, anchor };
    const moduleUrl = new URL("./journal-inputs.mjs", import.meta.url).href;
    const script = `import {captureJournalInputs,discoveryForJournal} from ${JSON.stringify(moduleUrl)};
      import {execFileSync} from 'node:child_process';
      const input=JSON.parse(process.argv[1]);
      let spawnCode;
      try{execFileSync('git',['--version'],{timeout:2000,stdio:'pipe'});}catch(error){spawnCode=error.code;}
      try{const captured=captureJournalInputs(input.home,{}, {paths:[input.target],resolveGitProjectAnchor:()=>input.anchor});
        const discovered=discoveryForJournal(captured,{},input.target);
        console.log(JSON.stringify({remote:captured.repositories[input.anchor.commonDir].remote,sourceHashes:discovered.sourceHashes,spawnCode}));
      }catch(error){console.log(JSON.stringify({error:error.message,code:error.cause?.code,spawnCode}));}`;
    const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(input)],
      { encoding: "utf8", env: { ...process.env, PATH: emptyPath }, timeout: 8000, maxBuffer: 8192 }));
    if (kind === "missing") expect(result).toEqual({ remote: null, sourceHashes: [], spawnCode: "ENOENT" });
    else expect(result.error).toBe("surface-prepared:inputs-unsupported-remote-observation");
    if (kind === "permission") expect(result.code).toBe("EACCES");
    if (kind === "timeout") expect(result.code).toBe("ETIMEDOUT");
  });

  it("admits separate same-remote clones but refuses a same-commonDir source", () => {
    const { home, target } = fixture();
    createGitFixture(target, { remote: "https://example.invalid/parity-import.git" });
    const clone = createGitFixture(join(home, "clone"), { remote: "https://example.invalid/parity-import.git" });
    const map = { [hash(clone)]: { canonical: clone, aliases: [] } };
    expect(discoveryForJournal(captureJournalInputs(home, map, options([target])), map, target).sourceHashes).toEqual([]);
    const linked = createLinkedWorktreeFixture(target, join(home, "linked"));
    const linkedMap = { [hash(linked)]: { canonical: linked, aliases: [] } };
    expect(() => discoveryForJournal(captureJournalInputs(home, linkedMap, options([target])), linkedMap, target))
      .toThrow("nonzero-current-sources");
  });

  it("requires exact target anchors and missing-to-fixed-Git transitions", () => {
    const { home, target } = fixture();
    const next = join(home, "new");
    const before = captureJournalInputs(home, {}, options([target, next]));
    createGitFixture(next);
    const current = captureJournalInputs(home, {}, options([target, next]));
    expect(() => assertJournalInputTransition(before, current, { newTargets: [next] })).not.toThrow();
    const forged = structuredClone(current);
    forged.observations[next][2] = join(target, ".git");
    expect(() => assertJournalInputTransition(before, forged, { newTargets: [next] })).toThrow("wrong-new-anchor");
    const bad = captureJournalInputs(home, {}, { paths: [target], resolveGitProjectAnchor: () => ({ commonDir: join(target, ".git"), canonical: next }) });
    expect(() => discoveryForJournal(bad, {}, target)).toThrow("target-anchor");
    expect(() => captureJournalInputs(home, {}, { paths: [target], resolveGitProjectAnchor: () => ({ commonDir: "relative", canonical: target }) }))
      .toThrow("invalid-anchor");
  });

  it("keeps future fixture targets missing until their declared transition", () => {
    const { home, target } = fixture();
    const first = join(home, "first");
    const future = join(home, "future");
    const before = captureJournalInputs(home, {}, options([target, first, future]));
    createGitFixture(first);
    const current = captureJournalInputs(home, {}, options([target, first, future]));
    expect(() => assertJournalInputTransition(before, current, { newTargets: [first] })).not.toThrow();
    expect(current.observations[future]).toEqual([future, "missing"]);
    createGitFixture(future);
    const premature = captureJournalInputs(home, {}, options([target, first, future]));
    expect(() => assertJournalInputTransition(before, premature, { newTargets: [first] })).toThrow("changed-mapped-path");
    expect(() => assertJournalInputTransition(before, premature, { newTargets: [first, future] })).not.toThrow();
  });

  it("applies ENOTDIR tolerance only outside strict target and historical source hashes", () => {
    const { home, target } = fixture();
    const file = join(home, "file");
    writeFileSync(file, "not a parent");
    const stale = join(file, "child");
    const map = { old: { canonical: stale, aliases: [] } };
    const input = captureJournalInputs(home, map, options([target]));
    expect(discoveryForJournal(input, map, target).discovery.mapFingerprint)
      .toBe(fingerprint([["old", stale, [], null, [[stale, "unavailable", "ENOTDIR"]]]]));
    expect(() => discoveryForJournal(input, map, target, ["old"])).toThrow("strict-parent-ENOTDIR");
  });

  it("retains directory metadata, exact depths and exhaustion, excluding transcript bytes", () => {
    const { home } = fixture();
    for (const [name, depth] of [["worktrees", 3], ["sessions", 5], ["archived_sessions", 2]] as const) {
      mkdirSync(join(home, ".codex", name, ...Array.from({ length: depth + 1 }, (_, i) => `d${i}`)), { recursive: true });
    }
    const original = captureCodexCatalogue(home);
    expect(original.catalogue).toHaveLength(4 + 6 + 3);
    expect(original.catalogue.every(row => row[1] === "dir" && typeof row[2] === "number" && typeof row[3] === "number")).toBe(true);
    const limited = captureCodexCatalogue(home, 2);
    expect(limited.complete).toBe(false);
    expect(limited.fingerprint).toBe(fingerprint({ catalogue: limited.catalogue, complete: false }));
    const transcript = join(home, ".codex", "sessions", "s.jsonl");
    writeFileSync(transcript, "before\n");
    const beforeAppend = captureCodexCatalogue(home);
    writeFileSync(transcript, "after, different bytes\n");
    expect(captureCodexCatalogue(home)).toEqual(beforeAppend);
  });

  it("rejects changed catalogue and bogus fingerprints; incomplete discovery is explicit", () => {
    const { home, target } = fixture();
    mkdirSync(join(home, ".codex", "sessions"), { recursive: true });
    const before = captureJournalInputs(home, {}, options([target]));
    const limited = captureJournalInputs(home, {}, { ...options([target]), maxEntries: 1 });
    expect(discoveryForJournal(limited, {}, target).discovery.complete).toBe(false);
    const bogus = structuredClone(before);
    bogus.codex.fingerprint = "wrong";
    expect(() => discoveryForJournal(bogus, {}, target)).toThrow("catalogue-fingerprint");
    mkdirSync(join(home, ".codex", "sessions", "new"));
    expect(() => assertJournalInputTransition(before, captureJournalInputs(home, {}, options([target]))))
      .toThrow("changed-codex-catalogue");
  });

  it("proves irrelevant historical corpus without assuming no sessions or owner metadata", () => {
    const { home, target } = fixture();
    const clone = createGitFixture(join(home, "clone"), { remote: "https://example.invalid/parity-import.git" });
    mkdirSync(join(clone, ".git", "refs"), { recursive: true });
    mkdirSync(join(clone, ".git", "worktrees", "parity-owner"), { recursive: true });
    writeFileSync(join(clone, ".git", "worktrees", "parity-owner", "codex-thread.json"), JSON.stringify({ version: 1, ownerThreadId: "old" }));
    mkdirSync(join(home, ".codex", "archived_sessions"), { recursive: true });
    mkdirSync(join(home, ".codex", "worktrees", "tombstone"), { recursive: true });
    writeFileSync(join(home, ".codex", "archived_sessions", "old.jsonl"), JSON.stringify({ type: "session_meta", payload: { id: "old" } }));
    const map = { [hash(target)]: { canonical: target, aliases: [] }, [hash(clone)]: { canonical: clone, aliases: [] } };
    const input = captureJournalInputs(home, map, options([target]));
    expect(input.repositories[join(clone, ".git")].owners).toHaveLength(1);
    expect(discoveryForJournal(input, map, target).aliases).toEqual([target]);
    expect(() => discoveryForJournal(input, map, clone)).toThrow("unsupported-historical-tombstones");
    writeFileSync(join(clone, ".git", "worktrees", "parity-owner", "gitdir"), join(home, "deleted", ".git"));
    const withHistory = captureJournalInputs(home, map, options([target]));
    expect(discoveryForJournal(withHistory, map, target).aliases).toEqual([target]);
    expect(() => discoveryForJournal(withHistory, map, clone)).toThrow("unsupported-historical-gitdir");
  });

  it("refuses canonical symlinks rather than overlooking a possible current source", () => {
    const { home, target } = fixture();
    const alias = join(home, "symlink");
    symlinkSync(target, alias);
    const map = { alias: { canonical: alias, aliases: [] } };
    expect(() => discoveryForJournal(captureJournalInputs(home, map, options([target])), map, target))
      .toThrow("unsupported-canonical-symlink");
  });
});
