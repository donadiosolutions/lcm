import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const renameControl = vi.hoisted(() => ({ error: undefined as NodeJS.ErrnoException | undefined }));
const crashControl = vi.hoisted(() => ({
  home: process.env.LCM_RUNTIME_PATH_CRASH_HOME,
  kind: process.env.LCM_RUNTIME_PATH_CRASH_KIND,
}));
const copyControl = vi.hoisted(() => ({
  disappearLstat: undefined as { path: string; atCall: number; calls: number } | undefined,
  failAfterCopyFrom: undefined as string | undefined,
  failChmodAt: undefined as string | undefined,
  failLstatAt: undefined as { path: string; error: NodeJS.ErrnoException } | undefined,
  failMkdirPrefix: undefined as string | undefined,
  failRemoveAt: undefined as string | undefined,
  failRemoveQuarantine: false,
  failRemoveSuffix: undefined as string | undefined,
  fstatMismatchAt: undefined as string | undefined,
  fakeQuarantineIdentity: undefined as { dev: string; ino: string } | undefined,
  openPaths: new Map<number, string>(),
  pretendExistsAt: undefined as string | undefined,
  mutateNestedPublishedTarget: undefined as {
    target: string;
    relativePath: string;
    content: string;
  } | undefined,
  mutateNestedTargetAfterCopy: undefined as {
    source: string;
    target: string;
    relativePath: string;
    content: string;
  } | undefined,
  mutateLeafPayloadAfterCopy: undefined as { source: string; content: string } | undefined,
  mutateTargetAfterSourceQuarantine: undefined as {
    source: string;
    target: string;
    relativePath: string;
    content: string;
  } | undefined,
  mutateDirectoryBetweenReads: undefined as { path: string; calls: number } | undefined,
  mutateDirectoryDuringFinalize: undefined as {
    target: string;
    relativePath: string;
    content: string;
    armed: boolean;
  } | undefined,
  driftDirectoryModeDuringFinalize: undefined as {
    target: string;
    mode: number;
    armed: boolean;
  } | undefined,
  mutateLeafAfterStagingCleanup: undefined as {
    target: string;
    kind: "file" | "mode" | "symlink";
    value?: string;
    mode?: number;
  } | undefined,
  mutateNestedSourceAfterCopy: undefined as {
    source: string;
    relativePath: string;
    content: string;
  } | undefined,
  publishedJournalAction: undefined as "remove" | "replace-target" | "rewrite-copying" | undefined,
  removePublishedJournalAfterStat: undefined as string | undefined,
  raceJournalLink: false,
  raceTokenLink: false,
  replaceDirectoryAfterCopy: undefined as { source: string; target: string; content: string } | undefined,
  replaceReadyDirectoryTarget: undefined as string | undefined,
  replaceBeforeQuarantine: undefined as {
    canonical: string;
    content: string;
    fakeIdentity?: { dev: string; ino: string };
  } | undefined,
  replaceSourceAfterCopyFrom: undefined as string | undefined,
  replaceSourceAfterPublication: undefined as string | undefined,
  replaceSourceAtWitness: undefined as { path: string; atCall: number; calls: number } | undefined,
  replaceStagingAfterCopyFrom: undefined as string | undefined,
  replaceTargetAfterLink: undefined as { target: string; content: string } | undefined,
  racedDirectoryTarget: undefined as { target: string; content: string } | undefined,
  racedTarget: undefined as { source: string; target: string; content: string } | undefined,
  unsupportedAfterCopyFrom: undefined as string | undefined,
  unsupportedPath: undefined as string | undefined,
  tokenDisappearAtCall: undefined as number | undefined,
  tokenLstatCalls: 0,
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    chmodSync: (
      path: Parameters<typeof actual.chmodSync>[0],
      mode: Parameters<typeof actual.chmodSync>[1],
    ): void => {
      if (copyControl.failChmodAt === path) {
        copyControl.failChmodAt = undefined;
        throw new Error("mode restoration failed");
      }
      actual.chmodSync(path, mode);
      const modeDrift = copyControl.driftDirectoryModeDuringFinalize;
      if (modeDrift?.target === path && modeDrift.armed) {
        copyControl.driftDirectoryModeDuringFinalize = undefined;
        actual.chmodSync(path, modeDrift.mode);
      }
      const mutation = copyControl.mutateDirectoryDuringFinalize;
      if (mutation?.target === path && mutation.armed) {
        copyControl.mutateDirectoryDuringFinalize = undefined;
        const nestedPath = join(mutation.target, mutation.relativePath);
        const before = actual.lstatSync(nestedPath);
        actual.writeFileSync(nestedPath, mutation.content);
        actual.utimesSync(nestedPath, before.atime, before.mtime);
      }
    },
    cpSync: (
      source: Parameters<typeof actual.cpSync>[0],
      destination: Parameters<typeof actual.cpSync>[1],
      options: Parameters<typeof actual.cpSync>[2],
    ): void => {
      const racedTarget = copyControl.racedTarget;
      if (racedTarget?.source === source) {
        copyControl.racedTarget = undefined;
        actual.writeFileSync(racedTarget.target, racedTarget.content);
      }
      actual.cpSync(source, destination, options);
      if (copyControl.mutateLeafPayloadAfterCopy?.source === source) {
        const mutation = copyControl.mutateLeafPayloadAfterCopy;
        copyControl.mutateLeafPayloadAfterCopy = undefined;
        actual.writeFileSync(destination, mutation.content);
      }
      const nestedSourceMutation = copyControl.mutateNestedSourceAfterCopy;
      if (nestedSourceMutation?.source === source) {
        copyControl.mutateNestedSourceAfterCopy = undefined;
        actual.writeFileSync(
          join(nestedSourceMutation.source, nestedSourceMutation.relativePath),
          nestedSourceMutation.content,
        );
      }
      const nestedTargetMutation = copyControl.mutateNestedTargetAfterCopy;
      if (nestedTargetMutation?.source === source) {
        copyControl.mutateNestedTargetAfterCopy = undefined;
        actual.writeFileSync(
          join(nestedTargetMutation.target, nestedTargetMutation.relativePath),
          nestedTargetMutation.content,
        );
      }
      if (copyControl.unsupportedAfterCopyFrom === source) {
        copyControl.unsupportedAfterCopyFrom = undefined;
        copyControl.unsupportedPath = String(destination);
      }
      if (copyControl.replaceStagingAfterCopyFrom === source) {
        copyControl.replaceStagingAfterCopyFrom = undefined;
        const staging = dirname(String(destination));
        actual.rmSync(staging, { recursive: true });
        actual.mkdirSync(staging);
        actual.writeFileSync(join(staging, "replacement.txt"), "replacement");
      }
      if (copyControl.replaceSourceAfterCopyFrom === source) {
        copyControl.replaceSourceAfterCopyFrom = undefined;
        actual.rmSync(source, { recursive: true });
        actual.writeFileSync(source, "replacement-source");
      }
      const replacement = copyControl.replaceDirectoryAfterCopy;
      if (replacement?.source === source) {
        copyControl.replaceDirectoryAfterCopy = undefined;
        actual.rmSync(replacement.target, { recursive: true });
        actual.mkdirSync(replacement.target);
        actual.writeFileSync(join(replacement.target, "replacement.txt"), replacement.content);
      }
      if (copyControl.failAfterCopyFrom === source) {
        copyControl.failAfterCopyFrom = undefined;
        throw new Error("copy failed after writing bytes");
      }
    },
    existsSync: (path: Parameters<typeof actual.existsSync>[0]): boolean => {
      if (copyControl.pretendExistsAt === path) return true;
      const exists = actual.existsSync(path);
      const racedDirectoryTarget = copyControl.racedDirectoryTarget;
      if (!exists && racedDirectoryTarget?.target === path) {
        copyControl.racedDirectoryTarget = undefined;
        actual.mkdirSync(path);
        actual.writeFileSync(join(String(path), "raced.txt"), racedDirectoryTarget.content);
      }
      return exists;
    },
    closeSync: (fd: number): void => {
      copyControl.openPaths.delete(fd);
      actual.closeSync(fd);
    },
    fstatSync: (fd: number, options?: Parameters<typeof actual.fstatSync>[1]) => {
      const stat = actual.fstatSync(fd, options);
      const openedPath = copyControl.openPaths.get(fd);
      if (copyControl.fstatMismatchAt === openedPath
        || (copyControl.fstatMismatchAt?.startsWith("*") && openedPath?.endsWith(copyControl.fstatMismatchAt.slice(1)))) {
        copyControl.fstatMismatchAt = undefined;
        return new Proxy(stat, {
          get(target, property, receiver) {
            if (property === "ino") return Number(target.ino) + 1;
            return Reflect.get(target, property, receiver) as unknown;
          },
        });
      }
      return stat;
    },
    linkSync: (existingPath: string, newPath: string): void => {
      if (copyControl.raceJournalLink && newPath.endsWith(".json")) {
        copyControl.raceJournalLink = false;
        actual.writeFileSync(newPath, "raced");
      }
      if (copyControl.raceTokenLink && newPath.endsWith(".token")) {
        copyControl.raceTokenLink = false;
        actual.writeFileSync(newPath, "raced");
      }
      actual.linkSync(existingPath, newPath);
      if (copyControl.replaceTargetAfterLink?.target === newPath) {
        const replacement = copyControl.replaceTargetAfterLink;
        copyControl.replaceTargetAfterLink = undefined;
        actual.rmSync(newPath);
        actual.writeFileSync(newPath, replacement.content);
      }
    },
    lstatSync: (
      path: Parameters<typeof actual.lstatSync>[0],
      options?: Parameters<typeof actual.lstatSync>[1],
    ) => {
      const value = String(path);
      const replaceAtWitness = copyControl.replaceSourceAtWitness;
      if (replaceAtWitness?.path === value && options && "bigint" in options && options.bigint) {
        replaceAtWitness.calls += 1;
        if (replaceAtWitness.calls === replaceAtWitness.atCall) {
          copyControl.replaceSourceAtWitness = undefined;
          actual.rmSync(value, { recursive: true, force: false });
          actual.writeFileSync(value, "replacement-source");
        }
      }
      if (value.endsWith(".token")) {
        copyControl.tokenLstatCalls += 1;
        if (copyControl.tokenDisappearAtCall === copyControl.tokenLstatCalls) {
          actual.rmSync(value, { force: true });
          throw Object.assign(new Error("gone"), { code: "ENOENT" });
        }
      }
      const failure = copyControl.failLstatAt;
      if (failure?.path === value) {
        copyControl.failLstatAt = undefined;
        throw failure.error;
      }
      const disappear = copyControl.disappearLstat;
      if (disappear?.path === value && ++disappear.calls === disappear.atCall) {
        actual.rmSync(value, { force: true });
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      }
      const stat = actual.lstatSync(path, options as { bigint?: false; throwIfNoEntry?: boolean });
      if (!stat) return undefined;
      if (copyControl.removePublishedJournalAfterStat === value) {
        copyControl.removePublishedJournalAfterStat = undefined;
        actual.rmSync(value);
      }
      const fakeIdentity = copyControl.fakeQuarantineIdentity;
      if (fakeIdentity && value.includes(".lcm-legacy-quarantine-")) {
        return new Proxy(stat, {
          get(target, property, receiver) {
            if (property === "dev") {
              return typeof target.dev === "bigint" ? BigInt(fakeIdentity.dev) : Number(fakeIdentity.dev);
            }
            if (property === "ino") {
              return typeof target.ino === "bigint" ? BigInt(fakeIdentity.ino) : Number(fakeIdentity.ino);
            }
            return Reflect.get(target, property, receiver) as unknown;
          },
        });
      }
      if (copyControl.unsupportedPath === value) {
        copyControl.unsupportedPath = undefined;
        return new Proxy(stat, {
          get(target, property, receiver) {
            if (property === "isDirectory" || property === "isFile" || property === "isSymbolicLink") {
              return () => false;
            }
            return Reflect.get(target, property, receiver) as unknown;
          },
        });
      }
      return stat;
    },
    mkdirSync: (
      path: Parameters<typeof actual.mkdirSync>[0],
      options?: Parameters<typeof actual.mkdirSync>[1],
    ) => {
      if (copyControl.failMkdirPrefix && String(path).startsWith(copyControl.failMkdirPrefix)) {
        copyControl.failMkdirPrefix = undefined;
        throw new Error("injected mkdir failure");
      }
      const result = actual.mkdirSync(path, options);
      if (crashControl.home) {
        const value = String(path);
        const directoryTarget = join(crashControl.home, ".lcm", "directory");
        const leafPrefix = join(crashControl.home, ".lcm", ".lcm-legacy-copy-");
        if ((crashControl.kind === "directory" && value === directoryTarget)
          || (crashControl.kind === "file" && value.startsWith(leafPrefix) && value.endsWith(".partial"))) {
          process.kill(process.pid, "SIGKILL");
        }
      }
      return result;
    },
    openSync: (
      path: Parameters<typeof actual.openSync>[0],
      flags: Parameters<typeof actual.openSync>[1],
      mode?: Parameters<typeof actual.openSync>[2],
    ): number => {
      const fd = actual.openSync(path, flags, mode);
      copyControl.openPaths.set(fd, String(path));
      return fd;
    },
    readdirSync: (path: Parameters<typeof actual.readdirSync>[0], options?: unknown) => {
      const mutation = copyControl.mutateDirectoryBetweenReads;
      if (mutation?.path === String(path)) {
        mutation.calls += 1;
        if (mutation.calls === 2) {
          copyControl.mutateDirectoryBetweenReads = undefined;
          actual.writeFileSync(join(String(path), "concurrent-entry.txt"), "concurrent");
        }
      }
      return (actual.readdirSync as (target: typeof path, settings?: unknown) => unknown)(path, options);
    },
    renameSync: (from: string, to: string): void => {
      if (renameControl.error && !from.endsWith(".tmp") && !to.includes(".lcm-legacy-quarantine-")) {
        throw renameControl.error;
      }
      const replacement = copyControl.replaceBeforeQuarantine;
      if (replacement?.canonical === from && to.includes(".lcm-legacy-quarantine-")) {
        copyControl.replaceBeforeQuarantine = undefined;
        actual.rmSync(from, { recursive: true, force: false });
        actual.writeFileSync(from, replacement.content);
        copyControl.fakeQuarantineIdentity = replacement.fakeIdentity;
      }
      actual.renameSync(from, to);
      const finalizeMutation = copyControl.mutateDirectoryDuringFinalize;
      if (finalizeMutation && from.endsWith(".tmp") && to.endsWith(".json")) {
        const metadata = JSON.parse(actual.readFileSync(to, "utf-8")) as ResidualMetadata;
        if (metadata.phase === "ready" && metadata.kind === "directory"
          && join(dirname(to), metadata.targetName) === finalizeMutation.target) {
          finalizeMutation.armed = true;
        }
      }
      const finalizeModeDrift = copyControl.driftDirectoryModeDuringFinalize;
      if (finalizeModeDrift && from.endsWith(".tmp") && to.endsWith(".json")) {
        const metadata = JSON.parse(actual.readFileSync(to, "utf-8")) as ResidualMetadata;
        if (metadata.phase === "ready" && metadata.kind === "directory"
          && join(dirname(to), metadata.targetName) === finalizeModeDrift.target) {
          finalizeModeDrift.armed = true;
        }
      }
      const afterQuarantineMutation = copyControl.mutateTargetAfterSourceQuarantine;
      if (afterQuarantineMutation?.source === from && to.includes(".lcm-legacy-quarantine-")) {
        copyControl.mutateTargetAfterSourceQuarantine = undefined;
        actual.writeFileSync(
          join(afterQuarantineMutation.target, afterQuarantineMutation.relativePath),
          afterQuarantineMutation.content,
        );
      }
      const nestedTargetMutation = copyControl.mutateNestedPublishedTarget;
      if (nestedTargetMutation && from.endsWith(".tmp") && to.endsWith(".json")) {
        const metadata = JSON.parse(actual.readFileSync(to, "utf-8")) as ResidualMetadata;
        if (metadata.phase === "published"
          && join(dirname(to), metadata.targetName) === nestedTargetMutation.target) {
          copyControl.mutateNestedPublishedTarget = undefined;
          actual.writeFileSync(
            join(nestedTargetMutation.target, nestedTargetMutation.relativePath),
            nestedTargetMutation.content,
          );
        }
      }
      if (copyControl.replaceSourceAfterPublication && from.endsWith(".tmp") && to.endsWith(".json")) {
        const metadata = JSON.parse(actual.readFileSync(to, "utf-8")) as ResidualMetadata;
        if (metadata.phase === "published") {
          const source = copyControl.replaceSourceAfterPublication;
          copyControl.replaceSourceAfterPublication = undefined;
          actual.rmSync(source, { recursive: true, force: false });
          actual.writeFileSync(source, "replacement-after-publication");
        }
      }
      if (copyControl.replaceReadyDirectoryTarget && from.endsWith(".tmp") && to.endsWith(".json")) {
        const metadata = JSON.parse(actual.readFileSync(to, "utf-8")) as ResidualMetadata;
        if (metadata.phase === "ready" && metadata.kind === "directory") {
          const target = copyControl.replaceReadyDirectoryTarget;
          copyControl.replaceReadyDirectoryTarget = undefined;
          actual.rmSync(target, { recursive: true, force: false });
          actual.mkdirSync(target);
          actual.writeFileSync(join(target, "replacement.txt"), "ready-replacement");
        }
      }
      const action = copyControl.publishedJournalAction;
      if (action && from.endsWith(".tmp") && to.endsWith(".json")) {
        const metadata = JSON.parse(actual.readFileSync(to, "utf-8")) as ResidualMetadata;
        if (metadata.phase === "published") {
          copyControl.publishedJournalAction = undefined;
          if (action === "remove") copyControl.removePublishedJournalAfterStat = to;
          else if (action === "rewrite-copying") {
            actual.writeFileSync(to, `${JSON.stringify({
              ...metadata,
              phase: "copying",
              objectDev: null,
              objectHash: null,
              objectIno: null,
              objectTreeHash: null,
            })}\n`);
          } else {
            const target = join(dirname(to), metadata.targetName);
            actual.rmSync(target, { recursive: true, force: false });
            actual.writeFileSync(target, "replacement-after-publication");
          }
        }
      }
    },
    rmSync: (
      path: Parameters<typeof actual.rmSync>[0],
      options?: Parameters<typeof actual.rmSync>[1],
    ): void => {
      if (copyControl.failRemoveQuarantine && String(path).includes(".lcm-legacy-quarantine-")) {
        copyControl.failRemoveQuarantine = false;
        throw new Error("injected removal failure");
      }
      if (copyControl.failRemoveAt === path) {
        copyControl.failRemoveAt = undefined;
        throw new Error("injected removal failure");
      }
      if (copyControl.failRemoveSuffix && String(path).endsWith(copyControl.failRemoveSuffix)) {
        copyControl.failRemoveSuffix = undefined;
        throw new Error("injected removal failure");
      }
      actual.rmSync(path, options);
      const mutation = copyControl.mutateLeafAfterStagingCleanup;
      let targetPresent = false;
      if (mutation) {
        try {
          actual.lstatSync(mutation.target);
          targetPresent = true;
        } catch { /* absent target cannot be mutated */ }
      }
      if (mutation && targetPresent && String(path).includes(".lcm-legacy-quarantine-")) {
        copyControl.mutateLeafAfterStagingCleanup = undefined;
        if (mutation.kind === "file") {
          const before = actual.lstatSync(mutation.target);
          actual.writeFileSync(mutation.target, mutation.value!);
          actual.utimesSync(mutation.target, before.atime, before.mtime);
        } else if (mutation.kind === "symlink") {
          actual.rmSync(mutation.target);
          actual.symlinkSync(mutation.value!, mutation.target);
        } else {
          actual.chmodSync(mutation.target, mutation.mode!);
        }
      }
    },
  };
});

import {
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
import { backendPublicationDirectory } from "../src/storage/backend-publication.js";

const homes: string[] = [];
afterEach(() => {
  renameControl.error = undefined;
  copyControl.disappearLstat = undefined;
  copyControl.failAfterCopyFrom = undefined;
  copyControl.failChmodAt = undefined;
  copyControl.failLstatAt = undefined;
  copyControl.failMkdirPrefix = undefined;
  copyControl.failRemoveAt = undefined;
  copyControl.failRemoveQuarantine = false;
  copyControl.failRemoveSuffix = undefined;
  copyControl.fstatMismatchAt = undefined;
  copyControl.fakeQuarantineIdentity = undefined;
  copyControl.openPaths.clear();
  copyControl.pretendExistsAt = undefined;
  copyControl.mutateNestedPublishedTarget = undefined;
  copyControl.mutateNestedSourceAfterCopy = undefined;
  copyControl.mutateNestedTargetAfterCopy = undefined;
  copyControl.mutateLeafPayloadAfterCopy = undefined;
  copyControl.mutateTargetAfterSourceQuarantine = undefined;
  copyControl.mutateDirectoryBetweenReads = undefined;
  copyControl.mutateDirectoryDuringFinalize = undefined;
  copyControl.driftDirectoryModeDuringFinalize = undefined;
  copyControl.mutateLeafAfterStagingCleanup = undefined;
  copyControl.publishedJournalAction = undefined;
  copyControl.removePublishedJournalAfterStat = undefined;
  copyControl.raceJournalLink = false;
  copyControl.raceTokenLink = false;
  copyControl.replaceDirectoryAfterCopy = undefined;
  copyControl.replaceReadyDirectoryTarget = undefined;
  copyControl.replaceBeforeQuarantine = undefined;
  copyControl.replaceSourceAfterCopyFrom = undefined;
  copyControl.replaceSourceAfterPublication = undefined;
  copyControl.replaceSourceAtWitness = undefined;
  copyControl.replaceStagingAfterCopyFrom = undefined;
  copyControl.replaceTargetAfterLink = undefined;
  copyControl.racedDirectoryTarget = undefined;
  copyControl.racedTarget = undefined;
  copyControl.unsupportedAfterCopyFrom = undefined;
  copyControl.unsupportedPath = undefined;
  copyControl.tokenDisappearAtCall = undefined;
  copyControl.tokenLstatCalls = 0;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function legacyHome(): { home: string; legacy: string; next: string } {
  const home = mkdtempSync(join(tmpdir(), "lcm-runtime-errors-"));
  homes.push(home);
  const legacy = legacyLcmHomeDir(home);
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "value.txt"), "value");
  return { home, legacy, next: lcmHomeDir(home) };
}

const RESIDUAL_NONCE = "a".repeat(48);

type ResidualKind = "directory" | "file" | "symlink";

type ResidualMetadata = {
  version: 1;
  phase: "reserved" | "copying" | "ready" | "published" | "removing";
  nonce: string;
  sourceName: string;
  targetName: string;
  sourceDev: string;
  sourceIno: string;
  sourceHash: string;
  sourceTreeHash: string;
  sourceMode: number;
  kind: ResidualKind;
  stagingName: string;
  reservedAtMs: number;
  containerDev: string | null;
  containerIno: string | null;
  containerHash: string | null;
  objectDev: string | null;
  objectIno: string | null;
  objectHash: string | null;
  objectTreeHash: string | null;
};

const TEST_STABLE_FIELDS = ["dev", "ino", "uid", "gid", "rdev", "birthtimeNs"] as const;
const TEST_IMMUTABLE_FIELDS = [...TEST_STABLE_FIELDS, "mode", "size", "mtimeNs"] as const;
function testStatHash(
  path: string,
  fields: readonly (keyof import("node:fs").BigIntStats)[],
): string {
  const stat = lstatSync(path, { bigint: true });
  return createHash("sha256")
    .update(fields.map((field) => `${String(field)}=${String(stat[field])}\n`).join(""))
    .digest("hex");
}

function updateTestTreePart(
  hash: ReturnType<typeof createHash>,
  label: string,
  value: string | Buffer,
): void {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  hash.update(`${label}\0${bytes.length}\0`);
  hash.update(bytes);
}

function testTreeWitness(rootPath: string, ignoredRootName?: string): {
  bindingHash: string;
  contentHash: string;
} {
  const binding = createHash("sha256");
  const content = createHash("sha256");
  const visit = (path: string, relativePath: string, isRoot: boolean): void => {
    const stat = lstatSync(path, { bigint: true });
    const kind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "symlink";
    updateTestTreePart(binding, "path", relativePath);
    updateTestTreePart(binding, "kind", kind);
    updateTestTreePart(
      binding,
      "metadata",
      createHash("sha256")
        .update((isRoot ? TEST_STABLE_FIELDS : TEST_IMMUTABLE_FIELDS)
          .map((field) => `${String(field)}=${String(stat[field])}\n`).join(""))
        .digest("hex"),
    );
    updateTestTreePart(content, "path", relativePath);
    updateTestTreePart(content, "kind", kind);
    if (!isRoot) updateTestTreePart(content, "mode", String(stat.mode & 0o7777n));
    if (kind === "file") {
      const bytes = readFileSync(path);
      binding.update(`file-bytes\0${String(stat.size)}\0`);
      binding.update(bytes);
      content.update(`file-bytes\0${String(stat.size)}\0`);
      content.update(bytes);
    } else if (kind === "symlink") {
      const target = readlinkSync(path, { encoding: "buffer" });
      updateTestTreePart(binding, "symlink", target);
      updateTestTreePart(content, "symlink", target);
    } else {
      for (const name of readdirSync(path).filter((name) => !isRoot || name !== ignoredRootName).sort()) {
        visit(join(path, name), relativePath ? `${relativePath}/${name}` : name, false);
      }
    }
  };
  visit(rootPath, "", true);
  return { bindingHash: binding.digest("hex"), contentHash: content.digest("hex") };
}

function residualPaths(target: string): { journal: string; root: string } {
  const root = dirname(target);
  const digest = createHash("sha256").update(target.split("/").at(-1) ?? "").digest("hex");
  return { journal: join(root, `.lcm-legacy-copy-${digest}.json`), root };
}

function quarantinePathFor(
  path: string,
  metadata: ResidualMetadata,
  role: "container" | "source",
): string {
  const parent = role === "source" ? dirname(dirname(path)) : dirname(path);
  const digest = createHash("sha256")
    .update(`${metadata.targetName}\0${metadata.nonce}\0${role}`)
    .digest("hex");
  return join(parent, `.lcm-legacy-quarantine-${digest}`);
}

function soleQuarantine(root: string): string {
  const names = readdirSync(root).filter((name) => name.startsWith(".lcm-legacy-quarantine-"));
  expect(names).toHaveLength(1);
  return join(root, names[0]!);
}

function residualMetadata(
  source: string,
  target: string,
  kind: ResidualKind,
  phase: ResidualMetadata["phase"],
  containerPath?: string,
  objectPath?: string,
): ResidualMetadata {
  const sourceStat = lstatSync(source);
  const containerStat = containerPath ? lstatSync(containerPath) : undefined;
  const objectStat = objectPath ? lstatSync(objectPath) : undefined;
  const targetName = target.split("/").at(-1) ?? "";
  return {
    version: 1,
    phase,
    nonce: RESIDUAL_NONCE,
    sourceName: source.split("/").at(-1) ?? "",
    targetName,
    sourceDev: String(sourceStat.dev),
    sourceIno: String(sourceStat.ino),
    sourceHash: testStatHash(source, TEST_IMMUTABLE_FIELDS),
    sourceTreeHash: testTreeWitness(source).bindingHash,
    sourceMode: sourceStat.mode,
    kind,
    stagingName: `.lcm-legacy-copy-${createHash("sha256")
      .update(`${targetName}\0${RESIDUAL_NONCE}`)
      .digest("hex")}.partial`,
    reservedAtMs: Date.now(),
    containerDev: containerStat ? String(containerStat.dev) : null,
    containerIno: containerStat ? String(containerStat.ino) : null,
    containerHash: containerStat ? testStatHash(containerPath!, TEST_STABLE_FIELDS) : null,
    objectDev: objectStat ? String(objectStat.dev) : null,
    objectIno: objectStat ? String(objectStat.ino) : null,
    objectHash: objectStat ? testStatHash(objectPath!, TEST_IMMUTABLE_FIELDS) : null,
    objectTreeHash: objectPath
      ? testTreeWitness(
        objectPath,
        phase === "ready" && kind === "directory"
          ? `.lcm-legacy-copy-${RESIDUAL_NONCE}.token`
          : undefined,
      ).bindingHash
      : null,
  };
}

function writeResidual(path: string, metadata: ResidualMetadata): void {
  writeFileSync(path, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
}

function writeResidualToken(container: string, metadata: ResidualMetadata): void {
  writeFileSync(
    join(container, `.lcm-legacy-copy-${metadata.nonce}.token`),
    `${JSON.stringify({
      nonce: metadata.nonce,
      sourceHash: metadata.sourceHash,
      sourceTreeHash: metadata.sourceTreeHash,
      sourceName: metadata.sourceName,
      targetName: metadata.targetName,
      version: 1,
    })}\n`,
    { mode: 0o600 },
  );
}

function seedDirectoryResidual(
  source: string,
  target: string,
  options: { ready?: boolean } = {},
): { metadata: ResidualMetadata; paths: ReturnType<typeof residualPaths> } {
  const paths = residualPaths(target);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  mkdirSync(target, { mode: 0o700 });
  writeFileSync(join(target, "copied.txt"), "copied");
  writeResidualToken(target, residualMetadata(source, target, "directory", "reserved"));
  const metadata = residualMetadata(
    source,
    target,
    "directory",
    options.ready ? "ready" : "copying",
    target,
    options.ready ? target : undefined,
  );
  writeResidual(paths.journal, metadata);
  return { metadata, paths };
}

function seedLeafResidual(
  source: string,
  target: string,
  options: { publish?: boolean; ready?: boolean } = {},
): { metadata: ResidualMetadata; paths: ReturnType<typeof residualPaths>; staging: string } {
  const paths = residualPaths(target);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const metadata = residualMetadata(source, target, "file", "reserved");
  const staging = join(paths.root, metadata.stagingName);
  mkdirSync(staging, { mode: 0o700 });
  writeResidualToken(staging, metadata);
  const payload = join(staging, "entry");
  writeFileSync(payload, "value", { mode: 0o640 });
  const journal = residualMetadata(
    source,
    target,
    "file",
    options.publish || options.ready ? "ready" : "copying",
    staging,
    options.publish || options.ready ? payload : undefined,
  );
  writeResidual(paths.journal, journal);
  if (options.publish) {
    linkSync(payload, target);
  }
  return { metadata: journal, paths, staging };
}

function seedReadySymlinkResidual(
  source: string,
  target: string,
): { metadata: ResidualMetadata; paths: ReturnType<typeof residualPaths>; staging: string } {
  const paths = residualPaths(target);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const metadata = residualMetadata(source, target, "symlink", "reserved");
  const staging = join(paths.root, metadata.stagingName);
  mkdirSync(staging, { mode: 0o700 });
  writeResidualToken(staging, metadata);
  const payload = join(staging, "entry");
  symlinkSync(readlinkSync(source), payload);
  const ready = residualMetadata(source, target, "symlink", "ready", staging, payload);
  writeResidual(paths.journal, ready);
  linkSync(payload, target);
  return { metadata: ready, paths, staging };
}

function seedPublishedDirectory(
  source: string,
  target: string,
  phase: "published" | "removing",
): { metadata: ResidualMetadata; paths: ReturnType<typeof residualPaths> } {
  const paths = residualPaths(target);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  mkdirSync(target, { mode: 0o750 });
  writeFileSync(join(target, "published.txt"), "published");
  const metadata = residualMetadata(source, target, "directory", phase, target, target);
  writeResidual(paths.journal, metadata);
  return { metadata, paths };
}

function seedPublishedLeaf(
  source: string,
  target: string,
  kind: "file" | "symlink",
  fixedTime?: Date,
): { metadata: ResidualMetadata; paths: ReturnType<typeof residualPaths> } {
  const paths = residualPaths(target);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  if (kind === "file") {
    writeFileSync(target, readFileSync(source), { mode: lstatSync(source).mode });
    if (fixedTime) {
      utimesSync(source, fixedTime, fixedTime);
      utimesSync(target, fixedTime, fixedTime);
    }
  } else {
    symlinkSync(readlinkSync(source), target);
  }
  const metadata = residualMetadata(source, target, kind, "published", target, target);
  writeResidual(paths.journal, metadata);
  return { metadata, paths };
}

describe("runtime home rename failures", () => {
  it.skipIf(!crashControl.home)("runtime SIGKILL worker", () => {
    const home = crashControl.home!;
    const legacy = legacyLcmHomeDir(home);
    mkdirSync(legacy, { recursive: true });
    if (crashControl.kind === "directory") {
      const source = join(legacy, "directory");
      mkdirSync(source, { mode: 0o750 });
      writeFileSync(join(source, "value.txt"), "directory-value");
    } else {
      writeFileSync(join(legacy, "value.txt"), "file-value", { mode: 0o640 });
    }
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    migrateLegacyHomeIfNeeded(home);
    throw new Error("SIGKILL injection did not fire");
  });

  it.skipIf(Boolean(crashControl.home))(
    "recovers without residue after a real SIGKILL immediately after container mkdir",
    () => {
      for (const kind of ["directory", "file"] as const) {
        const home = mkdtempSync(join(tmpdir(), `lcm-runtime-kill-${kind}-`));
        homes.push(home);
        const child = spawnSync(
          process.execPath,
          [
            join(process.cwd(), "node_modules", "vitest", "vitest.mjs"),
            "run",
            join(process.cwd(), "test", "coverage-cli-runtime-path-errors.test.ts"),
            "-t",
            "runtime SIGKILL worker",
            "--pool=threads",
            "--reporter=dot",
          ],
          {
            cwd: process.cwd(),
            encoding: "utf-8",
            env: {
              ...process.env,
              LCM_RUNTIME_PATH_CRASH_HOME: home,
              LCM_RUNTIME_PATH_CRASH_KIND: kind,
            },
          },
        );
        expect(child.status, `${child.stdout}\n${child.stderr}`).toBeNull();
        expect(child.signal, `${child.stdout}\n${child.stderr}`).toBe("SIGKILL");

        renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
        expect(migrateLegacyHomeIfNeeded(home).migrated).toBe(true);
        const target = kind === "directory"
          ? join(lcmHomeDir(home), "directory", "value.txt")
          : join(lcmHomeDir(home), "value.txt");
        expect(readFileSync(target, "utf-8")).toBe(`${kind}-value`);
        expect(existsSync(legacyLcmHomeDir(home))).toBe(false);
        const residue = [
          ...readdirSync(home),
          ...readdirSync(lcmHomeDir(home)),
        ].filter((name) => name.startsWith(".lcm-legacy-copy-")
          || name.startsWith(".lcm-legacy-quarantine-"));
        expect(residue).toEqual([]);
      }
    },
    20_000,
  );

  it("builds every public runtime path with explicit and default homes", () => {
    const explicitHome = "/tmp/runtime-path-home";
    expect(lcmPath("projects", "one")).toMatch(/\.lcm\/projects\/one$/);
    expect(configPath(explicitHome)).toBe(join(explicitHome, ".lcm", "config.json"));
    expect(daemonPidPath(explicitHome)).toBe(join(explicitHome, ".lcm", "daemon.pid"));
    expect(daemonTokenPath(explicitHome)).toBe(join(explicitHome, ".lcm", "daemon.token"));
    expect(projectsDir(explicitHome)).toBe(join(explicitHome, ".lcm", "projects"));
    expect(tmpDir(explicitHome)).toBe(join(explicitHome, ".lcm", "tmp"));
    expect(configPath()).toMatch(/\.lcm\/config\.json$/);
    expect(daemonPidPath()).toMatch(/\.lcm\/daemon\.pid$/);
    expect(daemonTokenPath()).toMatch(/\.lcm\/daemon\.token$/);
    expect(projectsDir()).toMatch(/\.lcm\/projects$/);
    expect(tmpDir()).toMatch(/\.lcm\/tmp$/);
  });

  it("falls back to copy-and-remove for cross-device renames", () => {
    const paths = legacyHome();
    const legacyValue = join(paths.legacy, "value.txt");
    chmodSync(legacyValue, 0o640);
    const nestedDir = join(paths.legacy, "nested");
    const deepDir = join(nestedDir, "deep");
    const nestedFile = join(deepDir, "mode.txt");
    mkdirSync(nestedDir, { mode: 0o750 });
    mkdirSync(deepDir, { mode: 0o710 });
    writeFileSync(nestedFile, "nested", { mode: 0o640 });
    const expectedDirectoryMode = statSync(nestedDir).mode & 0o777;
    const expectedDeepDirectoryMode = statSync(deepDir).mode & 0o777;
    const expectedFileMode = statSync(nestedFile).mode & 0o777;
    const expectedValueMode = statSync(legacyValue).mode & 0o777;
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    expect(migrateLegacyHomeIfNeeded(paths.home)).toEqual({
      migrated: true,
      from: paths.legacy,
      to: paths.next,
    });
    expect(readFileSync(join(paths.next, "value.txt"), "utf-8")).toBe("value");
    expect(statSync(join(paths.next, "value.txt")).mode & 0o777).toBe(expectedValueMode);
    const copiedDir = join(paths.next, "nested");
    const copiedDeepDir = join(copiedDir, "deep");
    const copiedFile = join(copiedDeepDir, "mode.txt");
    expect(readFileSync(copiedFile, "utf-8")).toBe("nested");
    expect(statSync(copiedDir).mode & 0o777).toBe(expectedDirectoryMode);
    expect(statSync(copiedDeepDir).mode & 0o777).toBe(expectedDeepDirectoryMode);
    expect(statSync(copiedFile).mode & 0o777).toBe(expectedFileMode);
    expect(existsSync(paths.legacy)).toBe(false);
  });

  it("rethrows non-cross-device rename failures", () => {
    const paths = legacyHome();
    renameControl.error = Object.assign(new Error("denied"), { code: "EACCES" });
    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("denied");
  });

  it("does not overwrite a target created between the existence check and cross-device copy", () => {
    const paths = legacyHome();
    const source = join(paths.legacy, "value.txt");
    const target = join(paths.next, "value.txt");
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    copyControl.racedTarget = { source, target, content: "raced" };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrowError(expect.objectContaining({
      code: "EEXIST",
    }));
    expect(readFileSync(target, "utf-8")).toBe("raced");
    expect(readFileSync(source, "utf-8")).toBe("value");
  });

  it("quarantines a directory target created between the existence check and reservation", () => {
    const paths = legacyHome();
    rmSync(join(paths.legacy, "value.txt"));
    const source = join(paths.legacy, "directory");
    const target = join(paths.next, "directory");
    mkdirSync(source);
    writeFileSync(join(source, "legacy.txt"), "legacy");
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    copyControl.racedDirectoryTarget = { target, content: "raced" };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow(
      "cross-device migration preserved an unrecognized container",
    );
    const quarantine = soleQuarantine(paths.next);
    expect(readFileSync(join(quarantine, "raced.txt"), "utf-8")).toBe("raced");
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(join(source, "legacy.txt"), "utf-8")).toBe("legacy");
  });

  it("removes an invocation-owned partial directory copy and recovers it on retry", () => {
    const paths = legacyHome();
    rmSync(join(paths.legacy, "value.txt"));
    const source = join(paths.legacy, "partial");
    const target = join(paths.next, "partial");
    mkdirSync(source);
    writeFileSync(join(source, "value.txt"), "partial");
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    copyControl.failAfterCopyFrom = source;

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("copy failed after writing bytes");
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(join(source, "value.txt"), "utf-8")).toBe("partial");

    expect(migrateLegacyHomeIfNeeded(paths.home).migrated).toBe(true);
    expect(readFileSync(join(target, "value.txt"), "utf-8")).toBe("partial");
    expect(existsSync(paths.legacy)).toBe(false);
  });

  it("removes a copied directory after mode restoration fails and recovers it on retry", () => {
    const paths = legacyHome();
    rmSync(join(paths.legacy, "value.txt"));
    const source = join(paths.legacy, "mode-copy");
    const target = join(paths.next, "mode-copy");
    mkdirSync(source, { mode: 0o750 });
    writeFileSync(join(source, "value.txt"), "mode-copy");
    const expectedMode = statSync(source).mode & 0o777;
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    copyControl.failChmodAt = target;

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("mode restoration failed");
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(join(source, "value.txt"), "utf-8")).toBe("mode-copy");

    expect(migrateLegacyHomeIfNeeded(paths.home).migrated).toBe(true);
    expect(readFileSync(join(target, "value.txt"), "utf-8")).toBe("mode-copy");
    expect(statSync(target).mode & 0o777).toBe(expectedMode);
    expect(existsSync(paths.legacy)).toBe(false);
  });

  it("preserves a cross-device symbolic link without dereferencing or rewriting it", () => {
    const paths = legacyHome();
    rmSync(join(paths.legacy, "value.txt"));
    const source = join(paths.legacy, "value-link");
    const target = join(paths.next, "value-link");
    writeFileSync(join(paths.home, "payload.txt"), "payload");
    symlinkSync("../payload.txt", source);
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });

    expect(migrateLegacyHomeIfNeeded(paths.home).migrated).toBe(true);
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(readlinkSync(target)).toBe("../payload.txt");
    expect(existsSync(paths.legacy)).toBe(false);
  });

  it("cleans a durable reservation left before target creation and retries", () => {
    const paths = legacyHome();
    mkdirSync(paths.next, { mode: 0o700 });
    const source = join(paths.legacy, "value.txt");
    const target = join(paths.next, "value.txt");
    const residual = residualPaths(target);
    writeResidual(residual.journal, residualMetadata(source, target, "file", "reserved"));
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });

    expect(migrateLegacyHomeIfNeeded(paths.home).migrated).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("value");
    expect(existsSync(paths.legacy)).toBe(false);
    expect(readdirSync(paths.next).filter((name) => name.startsWith(".lcm-legacy-copy-"))).toEqual([]);
  });

  it("removes an authenticated partial directory from a seeded crash and retries", () => {
    const paths = legacyHome();
    rmSync(join(paths.legacy, "value.txt"));
    const source = join(paths.legacy, "directory");
    const target = join(paths.next, "directory");
    mkdirSync(source, { mode: 0o750 });
    writeFileSync(join(source, "legacy.txt"), "legacy");
    seedDirectoryResidual(source, target);
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });

    expect(migrateLegacyHomeIfNeeded(paths.home).migrated).toBe(true);
    expect(readFileSync(join(target, "legacy.txt"), "utf-8")).toBe("legacy");
    expect(existsSync(join(target, "copied.txt"))).toBe(false);
    expect(readdirSync(paths.next).filter((name) => name.startsWith(".lcm-legacy-copy-"))).toEqual([]);
  });

  it("recognizes a fully published directory after a seeded crash before source removal", () => {
    const paths = legacyHome();
    rmSync(join(paths.legacy, "value.txt"));
    const source = join(paths.legacy, "directory");
    const target = join(paths.next, "directory");
    mkdirSync(source);
    writeFileSync(join(source, "legacy.txt"), "legacy");
    seedDirectoryResidual(source, target, { ready: true });

    expect(migrateLegacyHomeIfNeeded(paths.home).migrated).toBe(true);
    expect(readFileSync(join(target, "copied.txt"), "utf-8")).toBe("copied");
    expect(existsSync(paths.legacy)).toBe(false);
    expect(readdirSync(paths.next).filter((name) => name.startsWith(".lcm-legacy-copy-"))).toEqual([]);
  });

  it("covers container-token creation, validation, and deletion races", () => {
    const raced = legacyHome();
    rmSync(join(raced.legacy, "value.txt"));
    const racedSource = join(raced.legacy, "directory");
    mkdirSync(racedSource);
    writeFileSync(join(racedSource, "value.txt"), "value");
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    copyControl.raceTokenLink = true;
    expect(() => migrateLegacyHomeIfNeeded(raced.home)).toThrow(
      "cross-device migration preserved an unrecognized container",
    );
    expect(readdirSync(soleQuarantine(raced.next)).some((name) => name.endsWith(".token"))).toBe(true);

    const missing = legacyHome();
    rmSync(join(missing.legacy, "value.txt"));
    const missingSource = join(missing.legacy, "directory");
    const missingTarget = join(missing.next, "directory");
    mkdirSync(missingSource);
    writeFileSync(join(missingSource, "value.txt"), "value");
    const missingResidual = seedDirectoryResidual(missingSource, missingTarget, { ready: true });
    rmSync(join(missingTarget, `.lcm-legacy-copy-${missingResidual.metadata.nonce}.token`));
    expect(migrateLegacyHomeIfNeeded(missing.home).migrated).toBe(true);

    for (const [atCall, message] of [
      [2, "cross-device migration container token is missing or invalid"],
      [3, "cross-device migration container token disappeared"],
    ] as const) {
      const paths = legacyHome();
      rmSync(join(paths.legacy, "value.txt"));
      const source = join(paths.legacy, "directory");
      const target = join(paths.next, "directory");
      mkdirSync(source);
      writeFileSync(join(source, "value.txt"), "value");
      seedDirectoryResidual(source, target, { ready: true });
      copyControl.tokenLstatCalls = 0;
      copyControl.tokenDisappearAtCall = atCall;
      expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow(message);
      copyControl.tokenDisappearAtCall = undefined;
    }
  });

  it("removes authenticated leaf staging from a seeded mid-copy crash and retries", () => {
    const paths = legacyHome();
    const source = join(paths.legacy, "value.txt");
    const target = join(paths.next, "value.txt");
    const residual = seedLeafResidual(source, target);
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });

    expect(migrateLegacyHomeIfNeeded(paths.home).migrated).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("value");
    expect(existsSync(residual.staging)).toBe(false);
    expect(readdirSync(paths.next).filter((name) => name.startsWith(".lcm-legacy-copy-"))).toEqual([]);
  });

  it("recognizes a fully published leaf after a seeded crash before source removal", () => {
    const paths = legacyHome();
    const source = join(paths.legacy, "value.txt");
    const target = join(paths.next, "value.txt");
    const residual = seedLeafResidual(source, target, { publish: true });

    expect(migrateLegacyHomeIfNeeded(paths.home).migrated).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("value");
    expect(existsSync(residual.staging)).toBe(false);
    expect(existsSync(paths.legacy)).toBe(false);
    expect(readdirSync(paths.next).filter((name) => name.startsWith(".lcm-legacy-copy-"))).toEqual([]);
  });

  it("fails closed repeatedly for an ambiguous directory crash before ready publication", () => {
    const paths = legacyHome();
    rmSync(join(paths.legacy, "value.txt"));
    const source = join(paths.legacy, "directory");
    const target = join(paths.next, "directory");
    mkdirSync(source);
    writeFileSync(join(source, "legacy.txt"), "legacy");
    const residual = seedDirectoryResidual(source, target);
    writeResidual(
      residual.paths.journal,
      residualMetadata(source, target, "directory", "reserved"),
    );

    const quarantine = quarantinePathFor(target, residual.metadata, "container");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow(
        "cross-device migration preserved an unrecognized container",
      );
    }
    expect(readFileSync(join(source, "legacy.txt"), "utf-8")).toBe("legacy");
    expect(readFileSync(join(quarantine, "copied.txt"), "utf-8")).toBe("copied");
    expect(existsSync(target)).toBe(false);
    expect(existsSync(residual.paths.journal)).toBe(true);
  });

  it("never deletes a replacement for an authenticated partial directory", () => {
    const paths = legacyHome();
    rmSync(join(paths.legacy, "value.txt"));
    const source = join(paths.legacy, "directory");
    const target = join(paths.next, "directory");
    mkdirSync(source);
    writeFileSync(join(source, "legacy.txt"), "legacy");
    const residual = seedDirectoryResidual(source, target);
    rmSync(target, { recursive: true });
    mkdirSync(target);
    writeFileSync(join(target, "replacement.txt"), "replacement");

    const quarantine = quarantinePathFor(target, residual.metadata, "container");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow(
        "cross-device migration preserved an unrecognized container",
      );
    }
    expect(readFileSync(join(quarantine, "replacement.txt"), "utf-8")).toBe("replacement");
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(join(source, "legacy.txt"), "utf-8")).toBe("legacy");
  });

  it("fails closed when canonical and retained quarantine paths both exist", () => {
    const paths = legacyHome();
    rmSync(join(paths.legacy, "value.txt"));
    const source = join(paths.legacy, "directory");
    const target = join(paths.next, "directory");
    mkdirSync(source);
    writeFileSync(join(source, "legacy.txt"), "legacy");
    const residual = seedDirectoryResidual(source, target);
    const quarantine = quarantinePathFor(target, residual.metadata, "container");
    mkdirSync(quarantine);

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow(
      "cross-device migration found both canonical and quarantined container paths",
    );
    expect(readFileSync(join(target, "copied.txt"), "utf-8")).toBe("copied");
  });

  it("cleans owned leaf staging but fails closed for an intervening published target", () => {
    const paths = legacyHome();
    const source = join(paths.legacy, "value.txt");
    const target = join(paths.next, "value.txt");
    const residual = seedLeafResidual(source, target, { publish: true });
    rmSync(target);
    writeFileSync(target, "replacement");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow(
        "cross-device migration target changed before recovery",
      );
    }
    expect(readFileSync(target, "utf-8")).toBe("replacement");
    expect(readFileSync(source, "utf-8")).toBe("value");
    expect(existsSync(residual.staging)).toBe(false);
    expect(existsSync(residual.paths.journal)).toBe(true);
  });

  it("leaves a raced replacement untouched when caught cleanup loses directory identity", () => {
    const paths = legacyHome();
    rmSync(join(paths.legacy, "value.txt"));
    const source = join(paths.legacy, "directory");
    const target = join(paths.next, "directory");
    mkdirSync(source);
    writeFileSync(join(source, "legacy.txt"), "legacy");
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    copyControl.replaceDirectoryAfterCopy = { source, target, content: "replacement" };
    copyControl.failAfterCopyFrom = source;

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow(
      "cross-device migration preserved an unrecognized container",
    );
    const quarantine = soleQuarantine(paths.next);
    expect(readFileSync(join(quarantine, "replacement.txt"), "utf-8")).toBe("replacement");
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(join(source, "legacy.txt"), "utf-8")).toBe("legacy");
  });

  it("returns without migration for publication state, missing legacy state, and active-root markers", () => {
    const publication = legacyHome();
    copyControl.pretendExistsAt = backendPublicationDirectory(publication.home);
    expect(migrateLegacyHomeIfNeeded(publication.home).migrated).toBe(false);
    copyControl.pretendExistsAt = undefined;

    const missingHome = mkdtempSync(join(tmpdir(), "lcm-runtime-errors-"));
    homes.push(missingHome);
    expect(migrateLegacyHomeIfNeeded(missingHome).migrated).toBe(false);
    expect(existsSync(lcmHomeDir(missingHome))).toBe(true);

    for (const marker of ["config.json", "projects", "events"]) {
      const active = legacyHome();
      mkdirSync(active.next, { recursive: true });
      if (marker.endsWith(".json")) writeFileSync(join(active.next, marker), "{}");
      else mkdirSync(join(active.next, marker));
      expect(migrateLegacyHomeIfNeeded(active.home).migrated).toBe(false);
      expect(existsSync(active.legacy)).toBe(true);
    }
  });

  it("preserves established duplicate-target merge semantics", () => {
    const paths = legacyHome();
    mkdirSync(paths.next);
    writeFileSync(join(paths.next, "value.txt"), "current");

    expect(migrateLegacyHomeIfNeeded(paths.home).migrated).toBe(true);
    expect(readFileSync(join(paths.next, "value.txt"), "utf-8")).toBe("current");
    expect(existsSync(paths.legacy)).toBe(false);
  });

  it("fails closed on an invalid, non-regular, mismatched, or unreadable journal", () => {
    const invalid = legacyHome();
    mkdirSync(invalid.next);
    const invalidPath = residualPaths(join(invalid.next, "value.txt")).journal;
    writeFileSync(invalidPath, "null\n");
    expect(() => migrateLegacyHomeIfNeeded(invalid.home)).toThrow("invalid cross-device migration journal");

    const nonRegular = legacyHome();
    mkdirSync(nonRegular.next);
    mkdirSync(residualPaths(join(nonRegular.next, "value.txt")).journal);
    expect(() => migrateLegacyHomeIfNeeded(nonRegular.home)).toThrow(
      "cross-device migration journal is not a regular file",
    );

    const mismatched = legacyHome();
    mkdirSync(mismatched.next);
    const mismatchTarget = join(mismatched.next, "value.txt");
    const mismatch = residualMetadata(
      join(mismatched.legacy, "value.txt"),
      mismatchTarget,
      "file",
      "reserved",
    );
    writeResidual(residualPaths(mismatchTarget).journal, { ...mismatch, sourceName: "other.txt" });
    expect(() => migrateLegacyHomeIfNeeded(mismatched.home)).toThrow(
      "cross-device migration journal does not match the source entry",
    );

    const unsafeStaging = legacyHome();
    mkdirSync(unsafeStaging.next);
    const unsafeTarget = join(unsafeStaging.next, "value.txt");
    const unsafe = residualMetadata(
      join(unsafeStaging.legacy, "value.txt"),
      unsafeTarget,
      "file",
      "reserved",
    );
    writeResidual(residualPaths(unsafeTarget).journal, { ...unsafe, stagingName: "../outside" });
    expect(() => migrateLegacyHomeIfNeeded(unsafeStaging.home)).toThrow(
      "cross-device migration journal does not match the source entry",
    );

    const invalidShape = legacyHome();
    mkdirSync(invalidShape.next);
    const invalidShapeTarget = join(invalidShape.next, "value.txt");
    const badShape = residualMetadata(
      join(invalidShape.legacy, "value.txt"),
      invalidShapeTarget,
      "file",
      "reserved",
    );
    writeResidual(residualPaths(invalidShapeTarget).journal, {
      ...badShape,
      containerDev: "1",
      containerIno: "1",
    });
    expect(() => migrateLegacyHomeIfNeeded(invalidShape.home)).toThrow(
      "cross-device migration journal does not match the source entry",
    );

    const invalidSourceTree = legacyHome();
    mkdirSync(invalidSourceTree.next);
    const invalidSourceTreeTarget = join(invalidSourceTree.next, "value.txt");
    const badSourceTree = residualMetadata(
      join(invalidSourceTree.legacy, "value.txt"),
      invalidSourceTreeTarget,
      "file",
      "reserved",
    );
    writeResidual(residualPaths(invalidSourceTreeTarget).journal, {
      ...badSourceTree,
      sourceTreeHash: "b".repeat(63),
    });
    expect(() => migrateLegacyHomeIfNeeded(invalidSourceTree.home)).toThrow(
      "invalid cross-device migration journal",
    );

    const missingContainer = legacyHome();
    mkdirSync(missingContainer.next);
    const missingContainerTarget = join(missingContainer.next, "value.txt");
    const noContainer = residualMetadata(
      join(missingContainer.legacy, "value.txt"),
      missingContainerTarget,
      "file",
      "copying",
    );
    writeResidual(residualPaths(missingContainerTarget).journal, noContainer);
    expect(() => migrateLegacyHomeIfNeeded(missingContainer.home)).toThrow(
      "cross-device migration journal does not match the source entry",
    );

    const unreadable = legacyHome();
    mkdirSync(unreadable.next);
    const unreadableJournal = residualPaths(join(unreadable.next, "value.txt")).journal;
    copyControl.failLstatAt = {
      path: unreadableJournal,
      error: Object.assign(new Error("denied journal"), { code: "EACCES" }),
    };
    expect(() => migrateLegacyHomeIfNeeded(unreadable.home)).toThrow("denied journal");
  });

  it("accepts a valid symlink journal and rejects an unsupported EXDEV source type", () => {
    const symlink = legacyHome();
    rmSync(join(symlink.legacy, "value.txt"));
    const symlinkSource = join(symlink.legacy, "value-link");
    const symlinkTarget = join(symlink.next, "value-link");
    writeFileSync(join(symlink.home, "payload"), "payload");
    symlinkSync("../payload", symlinkSource);
    mkdirSync(symlink.next);
    writeResidual(
      residualPaths(symlinkTarget).journal,
      residualMetadata(symlinkSource, symlinkTarget, "symlink", "reserved"),
    );
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    expect(migrateLegacyHomeIfNeeded(symlink.home).migrated).toBe(true);
    expect(readlinkSync(symlinkTarget)).toBe("../payload");

    const unsupported = legacyHome();
    const unsupportedSource = join(unsupported.legacy, "value.txt");
    copyControl.unsupportedPath = unsupportedSource;
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    expect(() => migrateLegacyHomeIfNeeded(unsupported.home)).toThrow(
      "unsupported legacy entry type for cross-device migration",
    );
  });

  it("refuses a journal creation race without touching the source", () => {
    const paths = legacyHome();
    const source = join(paths.legacy, "value.txt");
    const target = join(paths.next, "value.txt");
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    copyControl.raceJournalLink = true;

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrowError(expect.objectContaining({ code: "EEXIST" }));
    expect(readFileSync(source, "utf-8")).toBe("value");
    expect(readFileSync(residualPaths(target).journal, "utf-8")).toBe("raced");
  });

  it("fails if an owned journal disappears at deletion", () => {
    const paths = legacyHome();
    mkdirSync(paths.next);
    const source = join(paths.legacy, "value.txt");
    const target = join(paths.next, "value.txt");
    const marker = residualPaths(target).journal;
    writeResidual(marker, residualMetadata(source, target, "file", "reserved"));
    copyControl.disappearLstat = { path: marker, atCall: 6, calls: 0 };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow(
      "cross-device migration journal disappeared",
    );
    expect(readFileSync(source, "utf-8")).toBe("value");

    const changed = legacyHome();
    mkdirSync(changed.next);
    const changedSource = join(changed.legacy, "value.txt");
    const changedTarget = join(changed.next, "value.txt");
    const changedMarker = residualPaths(changedTarget).journal;
    writeResidual(changedMarker, residualMetadata(changedSource, changedTarget, "file", "reserved"));
    copyControl.disappearLstat = { path: changedMarker, atCall: 5, calls: 0 };
    expect(() => migrateLegacyHomeIfNeeded(changed.home)).toThrow(
      "cross-device migration journal changed during cross-device migration",
    );
  });

  it("rejects a valid journal after its source witness changes", () => {
    const paths = legacyHome();
    mkdirSync(paths.next);
    const source = join(paths.legacy, "value.txt");
    const target = join(paths.next, "value.txt");
    const marker = residualPaths(target).journal;
    writeResidual(marker, residualMetadata(source, target, "file", "reserved"));
    writeFileSync(source, "changed-after-journal");
    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow(
      "cross-device migration journal does not match the source entry",
    );
  });

  it("preserves the source when directory or copied-file identity checks fail", () => {
    const directory = legacyHome();
    rmSync(join(directory.legacy, "value.txt"));
    const directorySource = join(directory.legacy, "directory");
    const directoryTarget = join(directory.next, "directory");
    mkdirSync(directorySource);
    writeFileSync(join(directorySource, "value.txt"), "value");
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    copyControl.fstatMismatchAt = directoryTarget;
    expect(() => migrateLegacyHomeIfNeeded(directory.home)).toThrow(
      "directory changed during cross-device migration",
    );
    expect(readFileSync(join(directorySource, "value.txt"), "utf-8")).toBe("value");

    const copiedFile = legacyHome();
    const fileSource = join(copiedFile.legacy, "value.txt");
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    copyControl.fstatMismatchAt = "*/entry";
    expect(() => migrateLegacyHomeIfNeeded(copiedFile.home)).toThrow(
      "copied file changed during cross-device migration",
    );
    expect(readFileSync(fileSource, "utf-8")).toBe("value");
  });

  it("rejects an unsupported copied entry and preserves a replaced source identity", () => {
    const unsupported = legacyHome();
    const unsupportedSource = join(unsupported.legacy, "value.txt");
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    copyControl.unsupportedAfterCopyFrom = unsupportedSource;
    expect(() => migrateLegacyHomeIfNeeded(unsupported.home)).toThrow(
      "unsupported copied entry type during cross-device migration",
    );
    expect(readFileSync(unsupportedSource, "utf-8")).toBe("value");

    const replaced = legacyHome();
    const replacedSource = join(replaced.legacy, "value.txt");
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    copyControl.replaceSourceAfterCopyFrom = replacedSource;
    expect(() => migrateLegacyHomeIfNeeded(replaced.home)).toThrow(
      "legacy source tree changed during cross-device migration",
    );
    expect(readFileSync(replacedSource, "utf-8")).toBe("replacement-source");

    const replacedDirectory = legacyHome();
    rmSync(join(replacedDirectory.legacy, "value.txt"));
    const directorySource = join(replacedDirectory.legacy, "directory");
    mkdirSync(directorySource);
    writeFileSync(join(directorySource, "value.txt"), "value");
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    copyControl.replaceSourceAtWitness = { path: directorySource, atCall: 2, calls: 0 };
    expect(() => migrateLegacyHomeIfNeeded(replacedDirectory.home)).toThrow(
      "migration tree path changed while building a migration tree witness",
    );
    expect(readFileSync(directorySource, "utf-8")).toBe("replacement-source");
  });

  it("preserves final-check source swaps even when the replacement reuses the recorded inode", () => {
    for (const reuseRecordedIdentity of [false, true]) {
      const paths = legacyHome();
      const source = join(paths.legacy, "value.txt");
      const target = join(paths.next, "value.txt");
      const original = lstatSync(source);
      renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
      copyControl.replaceBeforeQuarantine = {
        canonical: source,
        content: reuseRecordedIdentity ? "inode-reuse-replacement" : "final-check-replacement",
        fakeIdentity: reuseRecordedIdentity
          ? { dev: String(original.dev), ino: String(original.ino) }
          : undefined,
      };

      expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow(
        reuseRecordedIdentity
          ? "migration tree entry changed while building a migration tree witness"
          : "cross-device migration preserved an unrecognized source",
      );
      expect(readFileSync(target, "utf-8")).toBe("value");
      expect(existsSync(source)).toBe(false);
      expect(readFileSync(soleQuarantine(paths.home), "utf-8")).toBe(
        reuseRecordedIdentity ? "inode-reuse-replacement" : "final-check-replacement",
      );
      copyControl.fakeQuarantineIdentity = undefined;
    }
  });

  it("fails closed when a nested legacy file changes in place after the recursive copy", () => {
    const paths = legacyHome();
    rmSync(join(paths.legacy, "value.txt"));
    const source = join(paths.legacy, "directory");
    const target = join(paths.next, "directory");
    mkdirSync(join(source, "nested"), { recursive: true });
    writeFileSync(join(source, "nested", "value.txt"), "before-copy");
    symlinkSync("value.txt", join(source, "nested", "value-link"));
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    copyControl.mutateNestedSourceAfterCopy = {
      source,
      relativePath: join("nested", "value.txt"),
      content: "changed-after-copy",
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow(
      "legacy source tree changed during cross-device migration",
    );
    expect(readFileSync(join(source, "nested", "value.txt"), "utf-8")).toBe("changed-after-copy");
    expect(existsSync(target)).toBe(false);
  });

  it("rejects a copied directory whose nested bytes differ from the stable source tree", () => {
    const paths = legacyHome();
    rmSync(join(paths.legacy, "value.txt"));
    const source = join(paths.legacy, "directory");
    const target = join(paths.next, "directory");
    mkdirSync(join(source, "nested"), { recursive: true });
    writeFileSync(join(source, "nested", "value.txt"), "source-value");
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    copyControl.mutateNestedTargetAfterCopy = {
      source,
      target,
      relativePath: join("nested", "value.txt"),
      content: "different-copy",
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow(
      "copied directory tree does not match the legacy source",
    );
    expect(readFileSync(join(source, "nested", "value.txt"), "utf-8")).toBe("source-value");
    expect(existsSync(target)).toBe(false);
  });

  it("rejects a copied leaf whose bytes differ from the stable source witness", () => {
    const paths = legacyHome();
    const source = join(paths.legacy, "value.txt");
    const target = join(paths.next, "value.txt");
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    copyControl.mutateLeafPayloadAfterCopy = { source, content: "other" };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow(
      "copied leaf content does not match the legacy source",
    );
    expect(readFileSync(source, "utf-8")).toBe("value");
    expect(existsSync(target)).toBe(false);
  });

  it("detects same-inode same-size same-mtime byte drift in published file recovery", () => {
    const fixedTime = new Date("2024-01-02T03:04:05.000Z");

    const changedSource = legacyHome();
    const changedSourcePath = join(changedSource.legacy, "value.txt");
    const changedSourceTarget = join(changedSource.next, "value.txt");
    seedPublishedLeaf(changedSourcePath, changedSourceTarget, "file", fixedTime);
    const sourceBefore = lstatSync(changedSourcePath, { bigint: true });
    writeFileSync(changedSourcePath, "other");
    utimesSync(changedSourcePath, fixedTime, fixedTime);
    const sourceAfter = lstatSync(changedSourcePath, { bigint: true });
    expect(sourceAfter.ino).toBe(sourceBefore.ino);
    expect(sourceAfter.size).toBe(sourceBefore.size);
    expect(sourceAfter.mtimeNs).toBe(sourceBefore.mtimeNs);
    expect(() => migrateLegacyHomeIfNeeded(changedSource.home)).toThrow(
      "cross-device migration journal does not match the source entry",
    );
    expect(readFileSync(changedSourcePath, "utf-8")).toBe("other");
    expect(readFileSync(changedSourceTarget, "utf-8")).toBe("value");

    const changedTarget = legacyHome();
    const changedTargetSource = join(changedTarget.legacy, "value.txt");
    const changedTargetPath = join(changedTarget.next, "value.txt");
    seedPublishedLeaf(changedTargetSource, changedTargetPath, "file", fixedTime);
    const targetBefore = lstatSync(changedTargetPath, { bigint: true });
    writeFileSync(changedTargetPath, "other");
    utimesSync(changedTargetPath, fixedTime, fixedTime);
    const targetAfter = lstatSync(changedTargetPath, { bigint: true });
    expect(targetAfter.ino).toBe(targetBefore.ino);
    expect(targetAfter.size).toBe(targetBefore.size);
    expect(targetAfter.mtimeNs).toBe(targetBefore.mtimeNs);
    expect(() => migrateLegacyHomeIfNeeded(changedTarget.home)).toThrow(
      "cross-device migration published target changed before source removal",
    );
    expect(readFileSync(changedTargetSource, "utf-8")).toBe("value");
    expect(readFileSync(changedTargetPath, "utf-8")).toBe("other");
  });

  it("detects a same-length published symlink payload drift and preserves the source", () => {
    const paths = legacyHome();
    rmSync(join(paths.legacy, "value.txt"));
    const source = join(paths.legacy, "value-link");
    const target = join(paths.next, "value-link");
    symlinkSync("../one", source);
    seedPublishedLeaf(source, target, "symlink");
    rmSync(target);
    symlinkSync("../two", target);

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow(
      "cross-device migration published target changed before source removal",
    );
    expect(readlinkSync(source)).toBe("../one");
    expect(readlinkSync(target)).toBe("../two");
  });

  it("rejects in-window drift while promoting ready targets to published", () => {
    const directory = legacyHome();
    rmSync(join(directory.legacy, "value.txt"));
    const directorySource = join(directory.legacy, "directory");
    const directoryTarget = join(directory.next, "directory");
    mkdirSync(join(directorySource, "nested"), { recursive: true });
    writeFileSync(join(directorySource, "nested", "value.txt"), "stable");
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    copyControl.mutateDirectoryDuringFinalize = {
      target: directoryTarget,
      relativePath: join("nested", "value.txt"),
      content: "drift!",
      armed: false,
    };
    expect(() => migrateLegacyHomeIfNeeded(directory.home)).toThrow(
      "cross-device migration directory changed after ready publication",
    );
    expect(readFileSync(join(directorySource, "nested", "value.txt"), "utf-8")).toBe("stable");
    expect(readFileSync(join(directoryTarget, "nested", "value.txt"), "utf-8")).toBe("drift!");

    const normalLeaf = legacyHome();
    const normalLeafSource = join(normalLeaf.legacy, "value.txt");
    const normalLeafTarget = join(normalLeaf.next, "value.txt");
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    copyControl.mutateLeafAfterStagingCleanup = {
      target: normalLeafTarget,
      kind: "file",
      value: "other",
    };
    expect(() => migrateLegacyHomeIfNeeded(normalLeaf.home)).toThrow(
      "cross-device migration leaf target changed after ready publication",
    );
    expect(readFileSync(normalLeafSource, "utf-8")).toBe("value");
    expect(readFileSync(normalLeafTarget, "utf-8")).toBe("other");

    const recoveredLeaf = legacyHome();
    rmSync(join(recoveredLeaf.legacy, "value.txt"));
    const recoveredLeafSource = join(recoveredLeaf.legacy, "value-link");
    const recoveredLeafTarget = join(recoveredLeaf.next, "value-link");
    symlinkSync("../one", recoveredLeafSource);
    seedReadySymlinkResidual(recoveredLeafSource, recoveredLeafTarget);
    copyControl.mutateLeafAfterStagingCleanup = {
      target: recoveredLeafTarget,
      kind: "symlink",
      value: "../two",
    };
    expect(() => migrateLegacyHomeIfNeeded(recoveredLeaf.home)).toThrow(
      "cross-device migration leaf target changed after ready publication",
    );
    expect(readlinkSync(recoveredLeafSource)).toBe("../one");
    expect(readlinkSync(recoveredLeafTarget)).toBe("../two");
  });

  it("rejects in-window root-mode drift while promoting ready targets", () => {
    const directory = legacyHome();
    rmSync(join(directory.legacy, "value.txt"));
    const directorySource = join(directory.legacy, "directory");
    const directoryTarget = join(directory.next, "directory");
    mkdirSync(directorySource, { mode: 0o750 });
    writeFileSync(join(directorySource, "value.txt"), "value");
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    copyControl.driftDirectoryModeDuringFinalize = {
      target: directoryTarget,
      mode: 0o700,
      armed: false,
    };
    expect(() => migrateLegacyHomeIfNeeded(directory.home)).toThrow(
      "cross-device migration directory changed after ready publication",
    );
    expect(statSync(directorySource).mode & 0o777).toBe(0o750);
    expect(statSync(directoryTarget).mode & 0o777).toBe(0o700);

    const normalLeaf = legacyHome();
    const normalLeafSource = join(normalLeaf.legacy, "value.txt");
    const normalLeafTarget = join(normalLeaf.next, "value.txt");
    chmodSync(normalLeafSource, 0o640);
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    copyControl.mutateLeafAfterStagingCleanup = {
      target: normalLeafTarget,
      kind: "mode",
      mode: 0o600,
    };
    expect(() => migrateLegacyHomeIfNeeded(normalLeaf.home)).toThrow(
      "cross-device migration leaf target changed after ready publication",
    );
    expect(statSync(normalLeafSource).mode & 0o777).toBe(0o640);
    expect(statSync(normalLeafTarget).mode & 0o777).toBe(0o600);

    const recoveredLeaf = legacyHome();
    const recoveredLeafSource = join(recoveredLeaf.legacy, "value.txt");
    const recoveredLeafTarget = join(recoveredLeaf.next, "value.txt");
    seedLeafResidual(recoveredLeafSource, recoveredLeafTarget, { publish: true });
    copyControl.mutateLeafAfterStagingCleanup = {
      target: recoveredLeafTarget,
      kind: "mode",
      mode: 0o600,
    };
    expect(() => migrateLegacyHomeIfNeeded(recoveredLeaf.home)).toThrow(
      "cross-device migration leaf target changed after ready publication",
    );
    expect(readFileSync(recoveredLeafSource, "utf-8")).toBe("value");
    expect(statSync(recoveredLeafTarget).mode & 0o777).toBe(0o600);
  });

  it("detects a directory entry added between the tree witness scans", () => {
    const paths = legacyHome();
    rmSync(join(paths.legacy, "value.txt"));
    const source = join(paths.legacy, "directory");
    mkdirSync(source);
    writeFileSync(join(source, "value.txt"), "value");
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    copyControl.mutateDirectoryBetweenReads = { path: source, calls: 0 };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow(
      "migration directory entries changed while building a tree witness",
    );
    expect(readFileSync(join(source, "concurrent-entry.txt"), "utf-8")).toBe("concurrent");
  });

  it("preserves the source when a nested published target file changes before removal", () => {
    const paths = legacyHome();
    rmSync(join(paths.legacy, "value.txt"));
    const source = join(paths.legacy, "directory");
    const target = join(paths.next, "directory");
    mkdirSync(join(source, "nested"), { recursive: true });
    writeFileSync(join(source, "nested", "value.txt"), "published-value");
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    copyControl.mutateNestedPublishedTarget = {
      target,
      relativePath: join("nested", "value.txt"),
      content: "mutated-target",
    };

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow(
      "cross-device migration published target changed before source removal",
    );
    expect(readFileSync(join(source, "nested", "value.txt"), "utf-8")).toBe("published-value");
    expect(readFileSync(join(target, "nested", "value.txt"), "utf-8")).toBe("mutated-target");
  });

  it("fails closed for ready, published, and removing journal boundary replacements", () => {
    const ready = legacyHome();
    rmSync(join(ready.legacy, "value.txt"));
    const readySource = join(ready.legacy, "directory");
    const readyTarget = join(ready.next, "directory");
    mkdirSync(readySource);
    writeFileSync(join(readySource, "value.txt"), "value");
    seedDirectoryResidual(readySource, readyTarget, { ready: true });
    rmSync(readyTarget, { recursive: true });
    mkdirSync(readyTarget);
    writeFileSync(join(readyTarget, "replacement.txt"), "replacement");
    expect(() => migrateLegacyHomeIfNeeded(ready.home)).toThrow(
      "cross-device migration directory changed before publication",
    );

    const completed = legacyHome();
    rmSync(join(completed.legacy, "value.txt"));
    const completedSource = join(completed.legacy, "directory");
    const completedTarget = join(completed.next, "directory");
    mkdirSync(completedSource);
    writeFileSync(join(completedSource, "value.txt"), "value");
    seedPublishedDirectory(completedSource, completedTarget, "published");
    expect(migrateLegacyHomeIfNeeded(completed.home).migrated).toBe(true);
    expect(readFileSync(join(completedTarget, "published.txt"), "utf-8")).toBe("published");

    const published = legacyHome();
    rmSync(join(published.legacy, "value.txt"));
    const publishedSource = join(published.legacy, "directory");
    const publishedTarget = join(published.next, "directory");
    mkdirSync(publishedSource);
    writeFileSync(join(publishedSource, "value.txt"), "value");
    seedPublishedDirectory(publishedSource, publishedTarget, "published");
    rmSync(publishedTarget, { recursive: true });
    mkdirSync(publishedTarget);
    writeFileSync(join(publishedTarget, "replacement.txt"), "replacement");
    expect(() => migrateLegacyHomeIfNeeded(published.home)).toThrow(
      "cross-device migration published target changed before source removal",
    );

    for (const sourceState of ["canonical", "quarantined", "missing"] as const) {
      const removing = legacyHome();
      rmSync(join(removing.legacy, "value.txt"));
      const removingSource = join(removing.legacy, "directory");
      const removingTarget = join(removing.next, "directory");
      mkdirSync(removingSource);
      writeFileSync(join(removingSource, "value.txt"), "value");
      const residual = seedPublishedDirectory(removingSource, removingTarget, "removing");
      if (sourceState === "quarantined") {
        renameSync(removingSource, quarantinePathFor(removingSource, residual.metadata, "source"));
      } else if (sourceState === "missing") {
        rmSync(removingSource, { recursive: true });
      }
      expect(migrateLegacyHomeIfNeeded(removing.home).migrated).toBe(true);
      expect(existsSync(removingSource)).toBe(false);
      expect(existsSync(residual.paths.journal)).toBe(false);
    }
  });

  it("keeps source data when publication boundary checks fail", () => {
    const readyDirectory = legacyHome();
    rmSync(join(readyDirectory.legacy, "value.txt"));
    const readyDirectorySource = join(readyDirectory.legacy, "directory");
    const readyDirectoryTarget = join(readyDirectory.next, "directory");
    mkdirSync(readyDirectorySource);
    writeFileSync(join(readyDirectorySource, "value.txt"), "value");
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    copyControl.replaceReadyDirectoryTarget = readyDirectoryTarget;
    expect(() => migrateLegacyHomeIfNeeded(readyDirectory.home)).toThrow(
      "cross-device migration directory changed before publication",
    );
    expect(readFileSync(join(readyDirectorySource, "value.txt"), "utf-8")).toBe("value");
    expect(readFileSync(join(readyDirectoryTarget, "replacement.txt"), "utf-8")).toBe("ready-replacement");

    const afterLink = legacyHome();
    const afterLinkSource = join(afterLink.legacy, "value.txt");
    const afterLinkTarget = join(afterLink.next, "value.txt");
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    copyControl.replaceTargetAfterLink = { target: afterLinkTarget, content: "replacement-after-link" };
    expect(() => migrateLegacyHomeIfNeeded(afterLink.home)).toThrow(
      "published migration target changed during cross-device migration",
    );
    expect(readFileSync(afterLinkSource, "utf-8")).toBe("value");
    expect(readFileSync(afterLinkTarget, "utf-8")).toBe("replacement-after-link");

    const replacedSource = legacyHome();
    const replacedSourcePath = join(replacedSource.legacy, "value.txt");
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    copyControl.replaceSourceAfterPublication = replacedSourcePath;
    expect(() => migrateLegacyHomeIfNeeded(replacedSource.home)).toThrow(
      "cross-device migration source changed before source removal",
    );
    expect(readFileSync(replacedSourcePath, "utf-8")).toBe("replacement-after-publication");

    const duringRemoval = legacyHome();
    rmSync(join(duringRemoval.legacy, "value.txt"));
    const duringRemovalSource = join(duringRemoval.legacy, "directory");
    const duringRemovalTarget = join(duringRemoval.next, "directory");
    mkdirSync(join(duringRemovalSource, "nested"), { recursive: true });
    writeFileSync(join(duringRemovalSource, "nested", "value.txt"), "stable-source");
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    copyControl.mutateTargetAfterSourceQuarantine = {
      source: duringRemovalSource,
      target: duringRemovalTarget,
      relativePath: join("nested", "value.txt"),
      content: "changed-during-removal",
    };
    expect(() => migrateLegacyHomeIfNeeded(duringRemoval.home)).toThrow(
      "cross-device migration published target changed during source removal",
    );
    expect(existsSync(duringRemovalSource)).toBe(false);
    const sourceQuarantine = soleQuarantine(duringRemoval.home);
    expect(readFileSync(join(sourceQuarantine, "nested", "value.txt"), "utf-8")).toBe("stable-source");
    expect(readFileSync(join(duringRemovalTarget, "nested", "value.txt"), "utf-8"))
      .toBe("changed-during-removal");

    for (const [action, message] of [
      ["remove", "cross-device migration publication journal is missing"],
      ["rewrite-copying", "cross-device migration source removal was requested before publication"],
      ["replace-target", "cross-device migration published target changed before source removal"],
    ] as const) {
      const paths = legacyHome();
      const source = join(paths.legacy, "value.txt");
      const target = join(paths.next, "value.txt");
      renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
      copyControl.publishedJournalAction = action;
      expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow(message);
      expect(readFileSync(source, "utf-8")).toBe("value");
      if (action === "replace-target") {
        expect(readFileSync(target, "utf-8")).toBe("replacement-after-publication");
      }
    }
  });

  it("recovers ready leaves after staging cleanup and before publication", () => {
    const published = legacyHome();
    const publishedSource = join(published.legacy, "value.txt");
    const publishedTarget = join(published.next, "value.txt");
    const publishedResidual = seedLeafResidual(publishedSource, publishedTarget, { publish: true });
    rmSync(publishedResidual.staging, { recursive: true });
    expect(migrateLegacyHomeIfNeeded(published.home).migrated).toBe(true);
    expect(readFileSync(publishedTarget, "utf-8")).toBe("value");

    const beforeLink = legacyHome();
    const beforeLinkSource = join(beforeLink.legacy, "value.txt");
    const beforeLinkTarget = join(beforeLink.next, "value.txt");
    seedLeafResidual(beforeLinkSource, beforeLinkTarget, { ready: true });
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    expect(migrateLegacyHomeIfNeeded(beforeLink.home).migrated).toBe(true);
    expect(readFileSync(beforeLinkTarget, "utf-8")).toBe("value");

    const lostCopy = legacyHome();
    const lostSource = join(lostCopy.legacy, "value.txt");
    const lostTarget = join(lostCopy.next, "value.txt");
    const lostResidual = seedLeafResidual(lostSource, lostTarget, { ready: true });
    rmSync(lostResidual.staging, { recursive: true });
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    expect(migrateLegacyHomeIfNeeded(lostCopy.home).migrated).toBe(true);
    expect(readFileSync(lostTarget, "utf-8")).toBe("value");

    const interruptedCopy = legacyHome();
    const interruptedSource = join(interruptedCopy.legacy, "value.txt");
    const interruptedTarget = join(interruptedCopy.next, "value.txt");
    const interruptedResidual = seedLeafResidual(interruptedSource, interruptedTarget);
    rmSync(interruptedResidual.staging, { recursive: true });
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    expect(migrateLegacyHomeIfNeeded(interruptedCopy.home).migrated).toBe(true);
    expect(readFileSync(interruptedTarget, "utf-8")).toBe("value");
  });

  it("cleans caught leaf failures before and after staging ownership", () => {
    const copyFailure = legacyHome();
    const copySource = join(copyFailure.legacy, "value.txt");
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    copyControl.failAfterCopyFrom = copySource;
    expect(() => migrateLegacyHomeIfNeeded(copyFailure.home)).toThrow("copy failed after writing bytes");
    expect(readFileSync(copySource, "utf-8")).toBe("value");
    expect(readdirSync(copyFailure.next).filter((name) => name.startsWith(".lcm-legacy-copy-"))).toEqual([]);

    const mkdirFailure = legacyHome();
    const mkdirSource = join(mkdirFailure.legacy, "value.txt");
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    copyControl.failMkdirPrefix = join(mkdirFailure.next, ".lcm-legacy-copy-");
    expect(() => migrateLegacyHomeIfNeeded(mkdirFailure.home)).toThrow("injected mkdir failure");
    expect(readFileSync(mkdirSource, "utf-8")).toBe("value");
    expect(readdirSync(mkdirFailure.next).filter((name) => name.startsWith(".lcm-legacy-copy-"))).toEqual([]);

    const replacement = legacyHome();
    const replacementSource = join(replacement.legacy, "value.txt");
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    copyControl.replaceStagingAfterCopyFrom = replacementSource;
    copyControl.failAfterCopyFrom = replacementSource;
    expect(() => migrateLegacyHomeIfNeeded(replacement.home)).toThrow(
      "cross-device migration preserved an unrecognized container",
    );
    expect(readFileSync(replacementSource, "utf-8")).toBe("value");
    expect(readFileSync(join(soleQuarantine(replacement.next), "replacement.txt"), "utf-8"))
      .toBe("replacement");
  });

  it("recovers after a caught post-link staging cleanup failure", () => {
    const paths = legacyHome();
    const source = join(paths.legacy, "value.txt");
    const target = join(paths.next, "value.txt");
    renameControl.error = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    copyControl.failRemoveQuarantine = true;

    expect(() => migrateLegacyHomeIfNeeded(paths.home)).toThrow("injected removal failure");
    expect(readFileSync(source, "utf-8")).toBe("value");
    expect(readFileSync(target, "utf-8")).toBe("value");

    expect(migrateLegacyHomeIfNeeded(paths.home).migrated).toBe(true);
    expect(existsSync(source)).toBe(false);
    expect(readdirSync(paths.next).filter((name) => name.startsWith(".lcm-legacy-copy-"))).toEqual([]);
  });

});
