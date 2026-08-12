import { afterEach, describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BootstrapLockContentionError,
  bootstrapLcmHome,
  configPath,
  daemonPidPath,
  daemonTokenPath,
  legacyLcmHomeDir,
  lcmHomeDir,
  lcmPath,
  migrateLegacyHomeIfNeeded,
  projectsDir,
  tmpDir,
} from "../src/runtime-paths.js";
import { legacyLcmHomeDirname } from "../src/legacy-names.js";
import { processStartTime as trustedProcessStartTime } from "../src/private-mutation-lock.js";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "lcm-runtime-paths-"));
  homes.push(home);
  return home;
}

function processStartTime(pid = process.pid): string | null {
  try {
    const content = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = content.lastIndexOf(")");
    if (commandEnd < 0) return null;
    return content.slice(commandEnd + 2).trim().split(/\s+/u)[19] ?? null;
  } catch {
    return null;
  }
}

function writeBootstrapLock(
  home: string,
  owner: { pid: number; processStartTime: string | null },
  nonce = "0123456789abcdef0123456789abcdef",
): string {
  const content = `${JSON.stringify({
    version: 1,
    pid: owner.pid,
    processStartTime: owner.processStartTime,
    nonce,
  })}\n`;
  const path = join(home, ".lcm-root-bootstrap.lock");
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
  return content;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function migrationJournal(home: string, overrides: Record<string, unknown> = {}): void {
  const operationId = "0123456789abcdef0123456789abcdef0123456789abcdef";
  const stagingName = `.lcm-legacy-migration-${createHash("sha256")
    .update(`.lcm\0${operationId}`)
    .digest("hex")}.partial`;
  const { checksumSha256: requestedChecksum, ...payloadOverrides } = overrides;
  const payload: Record<string, unknown> = {
    version: overrides.version ?? 1,
    phase: "planned",
    operationId,
    sourceName: legacyLcmHomeDirname(),
    targetName: ".lcm",
    stagingName,
    source: { identity: { dev: "1", ino: "2" }, mode: 700, uid: 0, gid: 0, hash: "a".repeat(64) },
    target: null,
    targetBaseHash: null,
    ...(overrides.version === 2 ? { retained: null } : {}),
    ...payloadOverrides,
  };
  const journal = {
    ...payload,
    checksumSha256: typeof requestedChecksum === "string"
      ? requestedChecksum
      : createHash("sha256").update(canonical(payload)).digest("hex"),
  };
  writeFileSync(join(home, ".lcm-legacy-migration.json"), `${canonical(journal)}\n`, { mode: 0o600 });
  chmodSync(join(home, ".lcm-legacy-migration.json"), 0o600);
}

function treeWitness(root: string): Record<string, unknown> {
  const hash = createHash("sha256");
  const update = (label: string, value: string | Buffer): void => {
    const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
    hash.update(`${label}\0${bytes.byteLength}\0`);
    hash.update(bytes);
  };
  const visit = (path: string, relative: string, rootEntry: boolean): void => {
    const stat = lstatSync(path, { bigint: true });
    const directory = stat.isDirectory();
    update("path", relative);
    update("kind", directory ? "directory" : "file");
    if (!rootEntry) update("mode", String(Number(stat.mode & 0o7777n)));
    if (directory) {
      for (const name of readdirSync(path).sort()) {
        visit(join(path, name), relative ? `${relative}/${name}` : name, false);
      }
    } else {
      update("bytes", readFileSync(path));
    }
  };
  const stat = lstatSync(root, { bigint: true });
  visit(root, "", true);
  return {
    identity: { dev: String(stat.dev), ino: String(stat.ino) },
    mode: Number(stat.mode & 0o7777n),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
    hash: hash.digest("hex"),
  };
}

function migrationStagingPath(home: string): string {
  const operationId = "0123456789abcdef0123456789abcdef0123456789abcdef";
  const digest = createHash("sha256").update(`.lcm\0${operationId}`).digest("hex");
  return join(home, `.lcm-legacy-migration-${digest}.partial`);
}

describe("runtime paths", () => {
  it("uses ~/.lcm as the default LCM home", () => {
    expect(lcmHomeDir("/home/alice")).toBe("/home/alice/.lcm");
    expect(configPath("/home/alice")).toBe("/home/alice/.lcm/config.json");
  });

  it("keeps the legacy home path available for migration only", () => {
    expect(legacyLcmHomeDir("/home/alice")).toBe(join("/home/alice", legacyLcmHomeDirname()));
  });

  it("builds every runtime path, including default-home paths", () => {
    expect(lcmPath("nested", "value")).toBe(join(lcmHomeDir(), "nested", "value"));
    expect(configPath()).toBe(join(lcmHomeDir(), "config.json"));
    expect(daemonPidPath()).toBe(join(lcmHomeDir(), "daemon.pid"));
    expect(daemonTokenPath()).toBe(join(lcmHomeDir(), "daemon.token"));
    expect(projectsDir()).toBe(join(lcmHomeDir(), "projects"));
    expect(tmpDir()).toBe(join(lcmHomeDir(), "tmp"));
  });

  it("does not migrate when the legacy home is absent", () => {
    const home = makeHome();
    expect(migrateLegacyHomeIfNeeded(home)).toEqual({
      migrated: false,
      from: legacyLcmHomeDir(home),
      to: lcmHomeDir(home),
    });
    expect(existsSync(lcmHomeDir(home))).toBe(false);
    expect(bootstrapLcmHome(home)).toMatchObject({ created: true, migrated: false });
    expect(statSync(lcmHomeDir(home)).mode & 0o777).toBe(0o700);
  });

  it("accepts and reuses an existing exact private root", () => {
    const home = makeHome();
    mkdirSync(lcmHomeDir(home), { mode: 0o700 });

    expect(migrateLegacyHomeIfNeeded(home)).toEqual({
      migrated: false,
      from: legacyLcmHomeDir(home),
      to: lcmHomeDir(home),
    });
    expect(bootstrapLcmHome(home)).toMatchObject({ created: false, migrated: false });
  });

  it("uses the trusted non-Linux process-birth witness", () => {
    const expected = "darwin-birth-witness";
    const observed = trustedProcessStartTime(process.pid, (event, _path, mutable) => {
      if (event === "platform" && mutable) mutable.value = "darwin";
      if (event === "after-process-birth-command" && mutable) mutable.value = expected;
    });

    expect(observed).toBe(expected);
  });

  it("accepts a trusted non-numeric process-birth witness and reclaims on mismatch", () => {
    const home = makeHome();
    const content = writeBootstrapLock(home, {
      pid: process.pid,
      processStartTime: "darwin-birth-witness",
    });

    expect(bootstrapLcmHome(home)).toMatchObject({ created: true, migrated: false });
    expect(existsSync(join(home, ".lcm-root-bootstrap.lock"))).toBe(false);
    expect(content).toContain('"processStartTime":"darwin-birth-witness"');
  });

  it("recovers a bootstrap lock left by a definitively dead owner", () => {
    const home = makeHome();
    const lockPath = join(home, ".lcm-root-bootstrap.lock");
    writeFileSync(lockPath, JSON.stringify({
      version: 1,
      pid: process.pid + 1_000_000,
      processStartTime: "1",
      nonce: "0123456789abcdef0123456789abcdef",
    }) + "\n", { mode: 0o600 });
    chmodSync(lockPath, 0o600);

    expect(bootstrapLcmHome(home)).toMatchObject({ created: true, migrated: false });
    expect(existsSync(lockPath)).toBe(false);
    expect(statSync(lcmHomeDir(home)).mode & 0o777).toBe(0o700);
  });

  it("preserves a bootstrap lock owned by a live matching process", () => {
    const home = makeHome();
    const startTime = processStartTime();
    const content = writeBootstrapLock(home, {
      pid: process.pid,
      processStartTime: startTime,
    });

    let error: unknown;
    try {
      bootstrapLcmHome(home);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    if (startTime !== null) {
      expect((error as Error).constructor).toBe(BootstrapLockContentionError);
      expect((error as Error).message).toContain("verified live owner");
      expect((error as Error).message).toContain("automatic lock recovery was not attempted");
      expect((error as Error).message).toContain("retry after the competing LCM operation completes");
      expect((error as Error).message).toContain("do not delete the bootstrap lock manually");
    } else {
      expect((error as Error).constructor).toBe(Error);
      expect((error as Error).message).toContain("owner state is ambiguous");
    }
    expect(readFileSync(join(home, ".lcm-root-bootstrap.lock"), "utf8")).toBe(content);
  });

  it("reclaims a bootstrap lock whose live PID has a mismatched start witness", () => {
    const home = makeHome();
    const content = writeBootstrapLock(home, {
      pid: process.pid,
      processStartTime: "0",
    });

    expect(bootstrapLcmHome(home)).toMatchObject({ created: true, migrated: false });
    expect(existsSync(join(home, ".lcm-root-bootstrap.lock"))).toBe(false);
    expect(content).toContain('"processStartTime":"0"');
  });

  it("fails closed for an unavailable PID start witness", () => {
    const home = makeHome();
    const content = writeBootstrapLock(home, {
      pid: process.pid,
      processStartTime: null,
    });

    expect(() => bootstrapLcmHome(home)).toThrow("owner state is ambiguous");
    expect(readFileSync(join(home, ".lcm-root-bootstrap.lock"), "utf8")).toBe(content);
  });

  it("rejects an existing active root with a non-private mode", () => {
    const home = makeHome();
    mkdirSync(lcmHomeDir(home), { mode: 0o755 });
    chmodSync(lcmHomeDir(home), 0o755);

    expect(() => migrateLegacyHomeIfNeeded(home)).toThrow("exact mode 0700");
  });

  it("rejects an active root that is a regular file", () => {
    const home = makeHome();
    writeFileSync(lcmHomeDir(home), "not a directory");

    expect(() => migrateLegacyHomeIfNeeded(home)).toThrow();
  });

  it("rejects an active root symlink without following it", () => {
    const home = makeHome();
    const outside = join(home, "outside");
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, lcmHomeDir(home));

    expect(() => migrateLegacyHomeIfNeeded(home)).toThrow();
    expect(existsSync(join(outside, "config.json"))).toBe(false);
  });

  it("migrates an existing legacy home when the new home is absent", () => {
    const home = makeHome();
    const legacy = legacyLcmHomeDir(home);
    const next = lcmHomeDir(home);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "config.json"), JSON.stringify({ version: 1 }));

    const result = migrateLegacyHomeIfNeeded(home);

    expect(result).toEqual({ migrated: true, from: legacy, to: next });
    expect(readFileSync(join(legacy, "config.json"), "utf-8")).toBe(JSON.stringify({ version: 1 }));
    expect(existsSync(join(home, ".lcm-legacy-migration.json"))).toBe(true);
    expect(readFileSync(join(next, "config.json"), "utf-8")).toBe(JSON.stringify({ version: 1 }));
  });

  it("treats retained migration evidence as terminal after the active tree changes", () => {
    const home = makeHome();
    const legacy = legacyLcmHomeDir(home);
    const active = lcmHomeDir(home);
    mkdirSync(legacy, { mode: 0o700 });
    writeFileSync(join(legacy, "state"), "publication-time", { mode: 0o600 });

    expect(migrateLegacyHomeIfNeeded(home)).toEqual({ migrated: true, from: legacy, to: active });
    writeFileSync(join(active, "state"), "live-runtime-write", { mode: 0o600 });

    expect(migrateLegacyHomeIfNeeded(home)).toEqual({ migrated: true, from: legacy, to: active });
    expect(readFileSync(join(active, "state"), "utf-8")).toBe("live-runtime-write");
    const journal = JSON.parse(readFileSync(join(home, ".lcm-legacy-migration.json"), "utf-8")) as {
      phase: string;
      retained: unknown;
      stagingName: string;
      version: number;
    };
    expect(journal).toMatchObject({ phase: "retained", version: 2 });
    expect(journal.retained).not.toBeNull();
    expect(existsSync(join(home, journal.stagingName))).toBe(true);
  });

  it("does not reopen mutable migration evidence after the terminal transition", () => {
    const home = makeHome();
    const legacy = legacyLcmHomeDir(home);
    const active = lcmHomeDir(home);
    mkdirSync(legacy, { mode: 0o700 });
    writeFileSync(join(legacy, "state"), "publication-time", { mode: 0o600 });
    expect(migrateLegacyHomeIfNeeded(home).migrated).toBe(true);
    const journal = JSON.parse(readFileSync(join(home, ".lcm-legacy-migration.json"), "utf-8")) as {
      stagingName: string;
    };
    const retained = join(home, journal.stagingName);

    expect(existsSync(retained)).toBe(true);
    writeFileSync(join(legacy, "state"), "operator-changed-source", { mode: 0o600 });
    writeFileSync(join(retained, "state"), "operator-changed-retained-copy", { mode: 0o600 });
    expect(migrateLegacyHomeIfNeeded(home)).toEqual({ migrated: true, from: legacy, to: active });

    rmSync(legacy, { recursive: true, force: true });
    rmSync(retained, { recursive: true, force: true });
    expect(migrateLegacyHomeIfNeeded(home)).toEqual({ migrated: true, from: legacy, to: active });
  });

  it("uses actual platform semantics for nested legacy migration", () => {
    const home = realpathSync(makeHome());
    expect(existsSync(home)).toBe(true);
    expect(realpathSync(home)).toBe(home);
    const legacy = legacyLcmHomeDir(home);
    const nested = join(legacy, "projects", "nested");
    mkdirSync(nested, { recursive: true, mode: 0o750 });
    chmodSync(join(legacy, "projects"), 0o750);
    chmodSync(nested, 0o750);
    writeFileSync(join(nested, "state.json"), '{"ok":true}\n', { mode: 0o640 });

    if (process.platform === "darwin") {
      expect(() => migrateLegacyHomeIfNeeded(home)).toThrow(
        "legacy migration requires descriptor-relative filesystem access",
      );
      expect(existsSync(legacy)).toBe(true);
      expect(existsSync(lcmHomeDir(home))).toBe(false);
      return;
    }

    expect(migrateLegacyHomeIfNeeded(home).migrated).toBe(true);
    expect(readFileSync(join(lcmHomeDir(home), "projects", "nested", "state.json"), "utf-8"))
      .toBe('{"ok":true}\n');
    expect(statSync(join(lcmHomeDir(home), "projects", "nested")).mode & 0o777).toBe(0o750);
  });

  it("rejects a legacy root that is not a directory", () => {
    const home = makeHome();
    writeFileSync(legacyLcmHomeDir(home), "legacy file");

    expect(() => migrateLegacyHomeIfNeeded(home)).toThrow("legacy LCM home is not a trusted directory");
    expect(existsSync(lcmHomeDir(home))).toBe(false);
  });

  it.each(["{", "null", "[]"])("rejects a malformed migration journal: %s", (content) => {
    const home = makeHome();
    writeFileSync(join(home, ".lcm-legacy-migration.json"), content, { mode: 0o600 });

    expect(() => migrateLegacyHomeIfNeeded(home)).toThrow("legacy migration journal");
  });

  it("rejects a migration journal with unexpected fields", () => {
    const home = makeHome();
    migrationJournal(home, { extra: true });

    expect(() => migrateLegacyHomeIfNeeded(home)).toThrow("unexpected fields");
  });

  it.each([
    ["version", 3],
    ["phase", "unknown"],
    ["operationId", "bad"],
    ["sourceName", "wrong"],
    ["targetName", "wrong"],
    ["stagingName", "wrong"],
  ])("rejects invalid migration journal field %s", (field, value) => {
    const home = makeHome();
    migrationJournal(home, { [field]: value });

    expect(() => migrateLegacyHomeIfNeeded(home)).toThrow("journal fields are invalid");
  });

  it.each([
    ["retained", null],
    ["retaining", null],
    ["planned", { identity: { dev: "1", ino: "2" }, mode: 0o700, uid: 0, gid: 0, hash: "a".repeat(64) }],
  ])("rejects invalid version-2 retained evidence for phase %s", (phase, retained) => {
    const home = makeHome();
    const witness = { identity: { dev: "1", ino: "2" }, mode: 0o700, uid: 0, gid: 0, hash: "a".repeat(64) };
    migrationJournal(home, { version: 2, phase, target: witness, retained });

    expect(() => migrateLegacyHomeIfNeeded(home)).toThrow("retained evidence is invalid");
  });

  it("rejects a malformed migration journal checksum", () => {
    const home = makeHome();
    migrationJournal(home, { checksumSha256: "bad" });

    expect(() => migrateLegacyHomeIfNeeded(home)).toThrow("checksum is malformed");
  });

  it("rejects a malformed migration target base witness", () => {
    const home = makeHome();
    migrationJournal(home, { targetBaseHash: "bad" });

    expect(() => migrateLegacyHomeIfNeeded(home)).toThrow("target base witness is malformed");
  });

  it.each([
    ["source", null, "source witness is malformed"],
    ["target", {}, "target witness has unexpected fields"],
  ])("rejects a malformed %s migration witness", (field, value, message) => {
    const home = makeHome();
    migrationJournal(home, { [field]: value });

    expect(() => migrateLegacyHomeIfNeeded(home)).toThrow(message);
  });

  it("rejects a migration witness with unexpected fields", () => {
    const home = makeHome();
    migrationJournal(home, { source: { identity: { dev: "1", ino: "2" }, mode: 700, uid: 0, gid: 0, hash: "a".repeat(64), extra: true } });

    expect(() => migrateLegacyHomeIfNeeded(home)).toThrow("source witness has unexpected fields");
  });

  it.each([
    ["hash", "bad"],
    ["mode", -1],
    ["uid", -1],
    ["gid", -1],
  ])("rejects invalid migration witness field %s", (field, value) => {
    const home = makeHome();
    migrationJournal(home, {
      source: { identity: { dev: "1", ino: "2" }, mode: 700, uid: 0, gid: 0, hash: "a".repeat(64), [field]: value },
    });

    expect(() => migrateLegacyHomeIfNeeded(home)).toThrow("source witness fields are invalid");
  });

  it("rejects malformed and unexpected migration witness identities", () => {
    const malformed = makeHome();
    migrationJournal(malformed, { source: { identity: null, mode: 700, uid: 0, gid: 0, hash: "a".repeat(64) } });
    expect(() => migrateLegacyHomeIfNeeded(malformed)).toThrow("witness identity is malformed");

    const unexpected = makeHome();
    migrationJournal(unexpected, {
      source: { identity: { dev: "1", ino: "2", extra: "3" }, mode: 700, uid: 0, gid: 0, hash: "a".repeat(64) },
    });
    expect(() => migrateLegacyHomeIfNeeded(unexpected)).toThrow("witness identity has unexpected fields");

    const invalid = makeHome();
    migrationJournal(invalid, { source: { identity: { dev: "bad", ino: "2" }, mode: 700, uid: 0, gid: 0, hash: "a".repeat(64) } });
    expect(() => migrateLegacyHomeIfNeeded(invalid)).toThrow("source witness fields are invalid");
  });

  it("rejects a migration journal whose checksum does not match its payload", () => {
    const home = makeHome();
    migrationJournal(home, { checksumSha256: "0".repeat(64) });

    expect(() => migrateLegacyHomeIfNeeded(home)).toThrow("checksum does not match");
  });

  it("fails closed when valid migration evidence has no roots to authenticate", () => {
    const home = makeHome();
    migrationJournal(home);

    expect(() => migrateLegacyHomeIfNeeded(home)).toThrow("no authenticated source or target");
  });

  it("rejects a source whose authenticated witness no longer matches", () => {
    const home = makeHome();
    const legacy = legacyLcmHomeDir(home);
    mkdirSync(legacy, { mode: 0o700 });
    writeFileSync(join(legacy, "state"), "current");
    const source = treeWitness(legacy);
    source.hash = "b".repeat(64);
    migrationJournal(home, { source });

    expect(() => migrateLegacyHomeIfNeeded(home)).toThrow("legacy source changed during migration");
  });

  it("rejects a published target whose authenticated witness no longer matches", () => {
    const home = makeHome();
    const active = lcmHomeDir(home);
    mkdirSync(active, { mode: 0o700 });
    const target = treeWitness(active);
    (target.identity as Record<string, unknown>).ino = "999999999";
    migrationJournal(home, { phase: "published", target });

    expect(() => migrateLegacyHomeIfNeeded(home)).toThrow("active migration target changed during recovery");
  });

  it("rejects published evidence without a target witness", () => {
    const home = makeHome();
    mkdirSync(lcmHomeDir(home), { mode: 0o700 });
    migrationJournal(home, { phase: "published" });

    expect(() => migrateLegacyHomeIfNeeded(home)).toThrow("target witness is missing");
  });

  it("rejects published retained evidence that does not match the source witness", () => {
    const home = makeHome();
    const legacy = legacyLcmHomeDir(home);
    const active = lcmHomeDir(home);
    const retained = migrationStagingPath(home);
    mkdirSync(legacy, { mode: 0o700 });
    mkdirSync(active, { mode: 0o700 });
    mkdirSync(retained, { mode: 0o700 });
    writeFileSync(join(legacy, "state"), "source", { mode: 0o600 });
    writeFileSync(join(active, "state"), "source", { mode: 0o600 });
    writeFileSync(join(retained, "state"), "different", { mode: 0o600 });
    migrationJournal(home, {
      version: 2,
      phase: "published",
      source: treeWitness(legacy),
      target: treeWitness(active),
      retained: treeWitness(retained),
    });

    expect(() => migrateLegacyHomeIfNeeded(home)).toThrow("retained evidence does not match source");
  });

  it("adopts a complete retained copy recorded by backward published evidence", () => {
    const home = makeHome();
    const legacy = legacyLcmHomeDir(home);
    const active = lcmHomeDir(home);
    const retained = migrationStagingPath(home);
    for (const path of [legacy, active, retained]) {
      mkdirSync(path, { mode: 0o700 });
      writeFileSync(join(path, "state"), "source", { mode: 0o600 });
    }
    migrationJournal(home, {
      version: 2,
      phase: "published",
      source: treeWitness(legacy),
      target: treeWitness(active),
      retained: null,
    });

    expect(migrateLegacyHomeIfNeeded(home)).toEqual({ migrated: true, from: legacy, to: active });
    expect(JSON.parse(readFileSync(join(home, ".lcm-legacy-migration.json"), "utf-8")))
      .toMatchObject({ phase: "retained", retained: treeWitness(retained) });
  });

  it("resumes an authenticated empty retaining root", () => {
    const home = makeHome();
    const legacy = legacyLcmHomeDir(home);
    const active = lcmHomeDir(home);
    const retained = migrationStagingPath(home);
    mkdirSync(legacy, { mode: 0o700 });
    mkdirSync(active, { mode: 0o700 });
    mkdirSync(retained, { mode: 0o700 });
    writeFileSync(join(legacy, "state"), "source", { mode: 0o600 });
    writeFileSync(join(active, "state"), "source", { mode: 0o600 });
    migrationJournal(home, {
      version: 2,
      phase: "retaining",
      source: treeWitness(legacy),
      target: treeWitness(active),
      retained: treeWitness(retained),
    });

    expect(migrateLegacyHomeIfNeeded(home)).toEqual({ migrated: true, from: legacy, to: active });
    expect(readFileSync(join(retained, "state"), "utf-8")).toBe("source");
  });

  it("terminalizes an already complete retaining root", () => {
    const home = makeHome();
    const legacy = legacyLcmHomeDir(home);
    const active = lcmHomeDir(home);
    const retained = migrationStagingPath(home);
    for (const path of [legacy, active, retained]) {
      mkdirSync(path, { mode: 0o700 });
      writeFileSync(join(path, "state"), "source", { mode: 0o600 });
    }
    migrationJournal(home, {
      version: 2,
      phase: "retaining",
      source: treeWitness(legacy),
      target: treeWitness(active),
      retained: treeWitness(retained),
    });

    expect(migrateLegacyHomeIfNeeded(home)).toEqual({ migrated: true, from: legacy, to: active });
    expect(JSON.parse(readFileSync(join(home, ".lcm-legacy-migration.json"), "utf-8")))
      .toMatchObject({ phase: "retained" });
  });

  it("rejects a missing or identity-replaced retaining root", () => {
    const missingHome = makeHome();
    const missingLegacy = legacyLcmHomeDir(missingHome);
    const missingActive = lcmHomeDir(missingHome);
    const missingRetained = migrationStagingPath(missingHome);
    for (const path of [missingLegacy, missingActive, missingRetained]) mkdirSync(path, { mode: 0o700 });
    const missingWitness = treeWitness(missingRetained);
    migrationJournal(missingHome, {
      version: 2,
      phase: "retaining",
      source: treeWitness(missingLegacy),
      target: treeWitness(missingActive),
      retained: missingWitness,
    });
    rmSync(missingRetained, { recursive: true });
    expect(() => migrateLegacyHomeIfNeeded(missingHome)).toThrow("retaining root changed");

    const replacedHome = makeHome();
    const replacedLegacy = legacyLcmHomeDir(replacedHome);
    const replacedActive = lcmHomeDir(replacedHome);
    const replacedRetained = migrationStagingPath(replacedHome);
    for (const path of [replacedLegacy, replacedActive, replacedRetained]) mkdirSync(path, { mode: 0o700 });
    const replacedWitness = treeWitness(replacedRetained);
    migrationJournal(replacedHome, {
      version: 2,
      phase: "retaining",
      source: treeWitness(replacedLegacy),
      target: treeWitness(replacedActive),
      retained: replacedWitness,
    });
    renameSync(replacedRetained, `${replacedRetained}.replaced`);
    mkdirSync(replacedRetained, { mode: 0o700 });
    const replacementWitness = treeWitness(replacedRetained);
    expect(replacementWitness.identity).not.toEqual(replacedWitness.identity);
    expect(() => migrateLegacyHomeIfNeeded(replacedHome)).toThrow("retaining root changed");
  });

  it("rejects a non-empty or non-private unrecorded retained path", () => {
    for (const mode of [0o700, 0o755]) {
      const home = makeHome();
      const legacy = legacyLcmHomeDir(home);
      const active = lcmHomeDir(home);
      const retained = migrationStagingPath(home);
      mkdirSync(legacy, { mode: 0o700 });
      mkdirSync(active, { mode: 0o700 });
      mkdirSync(retained, { mode });
      chmodSync(retained, mode);
      writeFileSync(join(legacy, "state"), "source", { mode: 0o600 });
      writeFileSync(join(active, "state"), "source", { mode: 0o600 });
      if (mode === 0o700) writeFileSync(join(retained, "conflict"), "unexpected", { mode: 0o600 });
      migrationJournal(home, {
        version: 2,
        phase: "published",
        source: treeWitness(legacy),
        target: treeWitness(active),
        retained: null,
      });

      expect(() => migrateLegacyHomeIfNeeded(home)).toThrow("retained evidence path is not an empty private directory");
    }
  });

  it("adopts an existing empty retained path when getuid is unavailable", () => {
    const home = makeHome();
    const legacy = legacyLcmHomeDir(home);
    const active = lcmHomeDir(home);
    const retained = migrationStagingPath(home);
    mkdirSync(legacy, { mode: 0o700 });
    mkdirSync(active, { mode: 0o700 });
    mkdirSync(retained, { mode: 0o700 });
    writeFileSync(join(legacy, "state"), "source", { mode: 0o600 });
    writeFileSync(join(active, "state"), "source", { mode: 0o600 });
    migrationJournal(home, {
      version: 2,
      phase: "published",
      source: treeWitness(legacy),
      target: treeWitness(active),
      retained: null,
    });
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
    try {
      expect(migrateLegacyHomeIfNeeded(home)).toEqual({ migrated: true, from: legacy, to: active });
    } finally {
      if (descriptor === undefined) delete (process as { getuid?: () => number }).getuid;
      else Object.defineProperty(process, "getuid", descriptor);
    }
  });

  it("rejects a changed source before beginning retained evidence copy", () => {
    const home = makeHome();
    const legacy = legacyLcmHomeDir(home);
    const active = lcmHomeDir(home);
    mkdirSync(legacy, { mode: 0o700 });
    mkdirSync(active, { mode: 0o700 });
    writeFileSync(join(legacy, "state"), "source", { mode: 0o600 });
    writeFileSync(join(active, "state"), "source", { mode: 0o600 });
    const source = treeWitness(legacy);
    source.hash = "f".repeat(64);
    migrationJournal(home, {
      version: 2,
      phase: "published",
      source,
      target: treeWitness(active),
      retained: null,
    });

    expect(() => migrateLegacyHomeIfNeeded(home)).toThrow("legacy source changed during migration");
  });

  it("refuses planned evidence when an unauthenticated active root is present", () => {
    const home = makeHome();
    const legacy = legacyLcmHomeDir(home);
    mkdirSync(legacy, { mode: 0o700 });
    writeFileSync(join(legacy, "state"), "current");
    mkdirSync(lcmHomeDir(home), { mode: 0o700 });
    migrationJournal(home, { source: treeWitness(legacy) });

    expect(() => migrateLegacyHomeIfNeeded(home)).toThrow("unauthenticated active root");
  });

  it("rejects copying evidence when its staging tree is absent", () => {
    const home = makeHome();
    const legacy = legacyLcmHomeDir(home);
    mkdirSync(legacy, { mode: 0o700 });
    writeFileSync(join(legacy, "state"), "current");
    migrationJournal(home, { phase: "copying", source: treeWitness(legacy), target: treeWitness(legacy) });

    expect(() => migrateLegacyHomeIfNeeded(home)).toThrow("staging witness is missing or changed");
  });

  it.each(["published", "removing"])("finishes a %s journal when the target is authenticated", (phase) => {
    const home = makeHome();
    const active = lcmHomeDir(home);
    mkdirSync(active, { mode: 0o700 });
    writeFileSync(join(active, "state"), "published");
    migrationJournal(home, { phase, target: treeWitness(active) });

    expect(migrateLegacyHomeIfNeeded(home)).toEqual({ migrated: true, from: legacyLcmHomeDir(home), to: active });
    expect(existsSync(join(home, ".lcm-legacy-migration.json"))).toBe(false);
  });

  it("resumes a copying journal through publication and retained source evidence", () => {
    const home = makeHome();
    const legacy = legacyLcmHomeDir(home);
    const staging = migrationStagingPath(home);
    mkdirSync(legacy, { mode: 0o700 });
    mkdirSync(staging, { mode: 0o700 });
    writeFileSync(join(legacy, "state"), "current");
    writeFileSync(join(staging, "state"), "current");
    migrationJournal(home, { phase: "copying", source: treeWitness(legacy), target: treeWitness(staging) });

    expect(migrateLegacyHomeIfNeeded(home).migrated).toBe(true);
    expect(readFileSync(join(legacy, "state"), "utf-8")).toBe("current");
    expect(existsSync(join(home, ".lcm-legacy-migration.json"))).toBe(true);
    expect(readFileSync(join(lcmHomeDir(home), "state"), "utf-8")).toBe("current");
  });

  it("fails closed when the new home already has lcm data", () => {
    const home = makeHome();
    const legacy = legacyLcmHomeDir(home);
    const next = lcmHomeDir(home);
    mkdirSync(legacy, { recursive: true });
    mkdirSync(next, { recursive: true });
    writeFileSync(join(legacy, "config.json"), "legacy");
    writeFileSync(join(next, "config.json"), "new");

    expect(() => migrateLegacyHomeIfNeeded(home)).toThrow("coexist");
    expect(readFileSync(join(next, "config.json"), "utf-8")).toBe("new");
    expect(readFileSync(join(legacy, "config.json"), "utf-8")).toBe("legacy");
  });

  it.each(["projects", "events"])("does not migrate when the new home has %s data", (name) => {
    const home = makeHome();
    const legacy = legacyLcmHomeDir(home);
    const next = lcmHomeDir(home);
    mkdirSync(legacy, { recursive: true });
    mkdirSync(join(next, name), { recursive: true });

    expect(() => migrateLegacyHomeIfNeeded(home)).toThrow("coexist");
  });

  it("fails closed when the new home contains unrelated files beside legacy state", () => {
    const home = makeHome();
    const legacy = legacyLcmHomeDir(home);
    const next = lcmHomeDir(home);
    mkdirSync(legacy, { recursive: true });
    mkdirSync(next, { recursive: true });
    writeFileSync(join(legacy, "config.json"), "legacy");
    writeFileSync(join(next, "daemon.pid"), "new");

    expect(() => migrateLegacyHomeIfNeeded(home)).toThrow("coexist");
    expect(readFileSync(join(next, "daemon.pid"), "utf-8")).toBe("new");
    expect(readFileSync(join(legacy, "config.json"), "utf-8")).toBe("legacy");
  });

  it("fails closed when legacy and active roots have duplicate targets", () => {
    const home = makeHome();
    const legacy = legacyLcmHomeDir(home);
    const next = lcmHomeDir(home);
    mkdirSync(legacy, { recursive: true });
    mkdirSync(next, { recursive: true });
    writeFileSync(join(legacy, "shared.txt"), "legacy");
    writeFileSync(join(next, "shared.txt"), "current");

    expect(() => migrateLegacyHomeIfNeeded(home)).toThrow("coexist");
    expect(readFileSync(join(next, "shared.txt"), "utf-8")).toBe("current");
    expect(readFileSync(join(legacy, "shared.txt"), "utf-8")).toBe("legacy");
  });

  it("rejects a writable sticky actual home instead of trusting its root-owned exception", () => {
    const home = makeHome();
    chmodSync(home, 0o1777);
    expect(() => bootstrapLcmHome(home)).toThrow(/unsafe writable mode|owner is not trusted/);
    expect(existsSync(lcmHomeDir(home))).toBe(false);
  });

  it("rejects a symlinked home path before creating the private root", () => {
    const container = makeHome();
    const realHome = join(container, "real-home");
    const linkedHome = join(container, "linked-home");
    mkdirSync(realHome, { mode: 0o700 });
    symlinkSync(realHome, linkedHome);

    expect(() => bootstrapLcmHome(linkedHome)).toThrow();
    expect(existsSync(lcmHomeDir(realHome))).toBe(false);
  });

  it("rejects a home path reached through a symlinked parent", () => {
    const container = makeHome();
    const realParent = join(container, "real-parent");
    const linkedParent = join(container, "linked-parent");
    const realHome = join(realParent, "sub", "home");
    mkdirSync(realHome, { recursive: true, mode: 0o700 });
    symlinkSync(realParent, linkedParent);

    expect(() => bootstrapLcmHome(join(linkedParent, "sub", "home"))).toThrow("non-canonical");
    expect(existsSync(lcmHomeDir(realHome))).toBe(false);
  });

  it("rejects an unsafe home parent before root creation", () => {
    const container = makeHome();
    const home = join(container, "home");
    mkdirSync(home, { mode: 0o700 });
    chmodSync(container, 0o733);

    expect(() => bootstrapLcmHome(home)).toThrow("unsafe writable mode");
    expect(existsSync(lcmHomeDir(home))).toBe(false);
  });

  it("continues on systems without a getuid syscall", () => {
    const home = makeHome();
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
    try {
      expect(migrateLegacyHomeIfNeeded(home).migrated).toBe(false);
    } finally {
      if (descriptor === undefined) delete (process as { getuid?: () => number }).getuid;
      else Object.defineProperty(process, "getuid", descriptor);
    }
  });

  it("rejects a home owned by an unexpected user", () => {
    const home = makeHome();
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "getuid", { configurable: true, value: () => 999999 });
    try {
      expect(() => bootstrapLcmHome(home)).toThrow("owner is not trusted");
    } finally {
      if (descriptor === undefined) delete (process as { getuid?: () => number }).getuid;
      else Object.defineProperty(process, "getuid", descriptor);
    }
  });

  it("rejects symlink entries in legacy private state", () => {
    const home = makeHome();
    const legacy = legacyLcmHomeDir(home);
    mkdirSync(legacy, { mode: 0o700 });
    const target = join(home, "outside-state");
    writeFileSync(target, "outside");
    symlinkSync(target, join(legacy, "link"));

    expect(() => migrateLegacyHomeIfNeeded(home)).toThrow("symlink entries");
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(lcmHomeDir(home))).toBe(false);
  });
});
