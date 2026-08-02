import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

type HeldUnlinkNativeFault =
  | "anchored-lstat-error"
  | "canonical-close"
  | "canonical-open"
  | "canonical-proof"
  | "parent-close"
  | "parent-fsync"
  | "parent-post-proof"
  | "parent-post-realpath"
  | "parent-proof"
  | "parent-realpath"
  | "postclose-quarantine-open"
  | "target-close"
  | "target-open"
  | "target-post-proof-throw"
  | "target-post-proof"
  | "target-proof"
  | "unlink";

type PidQuarantineNativeFault =
  | "canonical-parent-close"
  | "canonical-parent-open"
  | "canonical-parent-proof"
  | "canonical-source-present"
  | "link-eexist"
  | "link-error"
  | "parent-close"
  | "parent-fsync"
  | "parent-post-proof"
  | "parent-post-realpath"
  | "parent-proof"
  | "parent-realpath"
  | "quarantine-close"
  | "quarantine-lstat-error"
  | "quarantine-open"
  | "quarantine-linked-proof"
  | "quarantine-linked-read"
  | "quarantine-post-proof"
  | "source-close"
  | "source-linked-proof"
  | "source-linked-read"
  | "source-open"
  | "source-open-parent-close"
  | "source-post-present"
  | "source-post-lstat-error"
  | "source-post-proof"
  | "source-proof"
  | "source-read"
  | "source-reopen"
  | "source-unlink";

type TerminalNativeMockState = {
  terminalReadReplacementTarget: string | null;
  terminalReadReplacementBytes: Buffer | null;
  terminalEmptyDynamicTarget: string | null;
  terminalHashFault: "digest-nonstring" | "digest-throw" | null;
  terminalPathFaultTarget: string | null;
  terminalPathFault: "fchmod-throw" | "fsync-throw" | "lstat-throw"
    | "readdir-empty" | "readdir-invalid" | "readdir-throw"
    | "readlink-mismatch" | "readlink-throw" | "realpath-throw"
    | "write-throw" | "write-zero" | null;
  capturedFstatFaultKind: "inode" | "mode" | "nlink" | "second-drift"
    | "size-negative" | "uid";
};

const fs = vi.hoisted(() => {
  const terminalNative: TerminalNativeMockState = {
    terminalReadReplacementTarget: null,
    terminalReadReplacementBytes: null,
    terminalEmptyDynamicTarget: null,
    terminalHashFault: null,
    terminalPathFaultTarget: null,
    terminalPathFault: null,
    capturedFstatFaultKind: "inode",
  };
  return {
  chmod: vi.fn(), exists: vi.fn(), lstat: vi.fn(), mkdtemp: vi.fn(), read: vi.fn(),
  readdir: vi.fn(), realpath: vi.fn(), rm: vi.fn(), stat: vi.fn(), unlink: vi.fn(),
  write: vi.fn(),
  passthrough: false,
  terminalFault: null as null | "early-eof" | "read-throw" | "second-fstat-drift"
    | "close-failure" | "size-zero" | "invalid-negative-count" | "invalid-overread-count",
  terminalTarget: null as string | null,
  terminalFaultDescriptor: null as number | null,
  terminalFaultConsumed: false,
  terminalFaultOrdinal: 1,
  terminalFaultMatchCount: 0,
  terminalFaultDescriptors: new Map<number, number>(),
  terminalInvalidRead: null as null | (() => void),
  ...terminalNative,
  terminalReadReplacementCalls: 0,
  terminalEmptyDynamicReadCalls: 0,
  terminalHashFaultCalls: 0,
  terminalPathFaultOrdinal: 1,
  terminalPathFaultCalls: 0,
  capturedOpenFaultTarget: null as string | null,
  capturedOpenFaultArmed: false,
  capturedOpenFaultConsumed: false,
  capturedOpenFaultOrdinal: 1,
  capturedOpenFaultMatchCount: 0,
  capturedOpenFaultDescriptors: new Map<number, number>(),
  capturedOpenFaultObservation: null as null | ((
    path: string,
    event: "open" | "close" | "fault",
    ordinal: number,
    descriptor: number | null,
  ) => void),
  passiveOpenObservationTarget: null as string | null,
  passiveOpenObservationOrdinal: 1,
  passiveOpenObservationCount: 0,
  passiveOpenObservation: null as null | (() => void),
  capturedFstatFaultTarget: null as string | null,
  capturedFstatFaultDescriptor: null as number | null,
  capturedFstatFaultArmed: false,
  capturedFstatFaultConsumed: false,
  capturedFstatFaultCount: 0,
  capturedFstatFaultIno: null as number | null,
  capturedFstatFaultOrdinal: 1,
  capturedFstatFaultMatchCount: 0,
  capturedFstatFaultObservation: null as null | ((
    event: "fstat" | "close",
    path: string,
    descriptor: number,
    count: number,
    inode: number | null,
  ) => void),
  tokenReadTarget: null as string | null,
  tokenContentReadCalls: 0,
  tokenContentReadObservation: null as null | ((path: string, count: number) => void),
  descriptorPaths: new Map<number, string>(),
  descriptorFstatCalls: new Map<number, number>(),
  descriptorReadCalls: new Map<number, number>(),
  descriptorCloseCalls: new Set<number>(),
  heldUnlinkTarget: null as string | null,
  heldUnlinkFaults: new Set<HeldUnlinkNativeFault>(),
  heldUnlinkFaultCalls: new Map<HeldUnlinkNativeFault, number>(),
  heldUnlinkParentDescriptor: null as number | null,
  heldUnlinkNativeStartTokenReads: null as number | null,
  heldUnlinkTargetDescriptor: null as number | null,
  heldUnlinkCanonicalDescriptor: null as number | null,
  heldUnlinkParentFstatCalls: 0,
  heldUnlinkTargetFstatCalls: 0,
  heldUnlinkCanonicalFstatCalls: 0,
  heldUnlinkParentRealpathCalls: 0,
  heldUnlinkObserved: false,
  heldUnlinkCompletionObservation: null as null | (() => void),
  pidQuarantineRoot: null as string | null,
  pidQuarantinePidPath: null as string | null,
  pidQuarantinePath: null as string | null,
  pidQuarantineFault: null as PidQuarantineNativeFault | null,
  pidQuarantineFaultCalls: 0,
  pidQuarantineRootOpenCount: 0,
  pidQuarantineParentOpenOrdinal: 0,
  pidQuarantineParentDescriptor: null as number | null,
  pidQuarantineCanonicalParentDescriptor: null as number | null,
  pidQuarantineSourceDescriptors: [] as number[],
  pidQuarantineSourceOrdinals: new Map<number, number>(),
  pidQuarantineDescriptorRoles: new Map<number, "parent" | "canonical-parent" | "source" | "quarantine">(),
  pidQuarantineFstatCalls: new Map<number, number>(),
  pidQuarantineReadCalls: new Map<number, number>(),
  pidQuarantineSourceUnlinked: false,
  pidQuarantineLinkCalls: 0,
  };
});
vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:crypto")>();
  const hashes = new WeakMap<object, ReturnType<typeof original.createHash>>();
  function update(this: object, ...args: unknown[]): object {
    const hash = hashes.get(this);
    if (hash === undefined) throw new Error("captured hash receiver is missing");
    Reflect.apply(hash.update, hash, args);
    return this;
  }
  function digest(this: object, ...args: unknown[]): unknown {
    const hash = hashes.get(this);
    if (hash === undefined) throw new Error("captured hash receiver is missing");
    if (fs.terminalHashFault !== null) {
      fs.terminalHashFaultCalls += 1;
      if (fs.terminalHashFault === "digest-throw") {
        throw new Error("captured hash digest failure");
      }
      return Buffer.alloc(0);
    }
    return Reflect.apply(hash.digest, hash, args);
  }
  return {
    ...original,
    createHash: (...args: unknown[]) => {
      const hash = Reflect.apply(original.createHash, original, args);
      const wrapper = { update, digest };
      hashes.set(wrapper, hash);
      return wrapper;
    },
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  const heldFaultEnabled = (fault: HeldUnlinkNativeFault): boolean => (
    fs.heldUnlinkFaults.has(fault) && !fs.heldUnlinkFaultCalls.has(fault)
  );
  const consumeHeldFault = (fault: HeldUnlinkNativeFault): void => {
    fs.heldUnlinkFaultCalls.set(fault, 1);
  };
  const heldParentPath = (): string | null => fs.heldUnlinkTarget === null
    ? null
    : fs.heldUnlinkTarget.slice(0, fs.heldUnlinkTarget.lastIndexOf("/"));
  const heldAnchoredDescriptor = (path: string): number | null => {
    const match = /^\/proc\/self\/fd\/(\d+)(?:\/.*)?$/u.exec(path);
    if (match?.[1] === undefined) return null;
    const descriptor = Number(match[1]);
    return Number.isSafeInteger(descriptor) ? descriptor : null;
  };
  const heldAnchoredParentMatches = (path: string): boolean => {
    const descriptor = heldAnchoredDescriptor(path);
    return descriptor !== null
      && path === `/proc/self/fd/${String(descriptor)}`
      && fs.descriptorPaths.get(descriptor) === heldParentPath();
  };
  const heldAnchoredLeafMatches = (path: string): boolean => {
    const descriptor = heldAnchoredDescriptor(path);
    const target = fs.heldUnlinkTarget;
    return descriptor !== null
      && target !== null
      && path === `/proc/self/fd/${String(descriptor)}/${target.slice(target.lastIndexOf("/") + 1)}`
      && fs.descriptorPaths.get(descriptor) === heldParentPath();
  };
  const pidQuarantineConsumeFault = (fault: PidQuarantineNativeFault): boolean => {
    if (fs.pidQuarantineFault !== fault || fs.pidQuarantineFaultCalls !== 0) return false;
    fs.pidQuarantineFaultCalls = 1;
    return true;
  };
  const pidQuarantineAnchored = (
    path: string,
  ): Readonly<{ descriptor: number; leaf: string | null }> | null => {
    const match = /^\/proc\/self\/fd\/(\d+)(?:\/(.*))?$/u.exec(path);
    if (match?.[1] === undefined) return null;
    const descriptor = Number(match[1]);
    if (
      !Number.isSafeInteger(descriptor)
      || fs.pidQuarantineRoot === null
      || fs.descriptorPaths.get(descriptor) !== fs.pidQuarantineRoot
    ) return null;
    return { descriptor, leaf: match[2] ?? null };
  };
  const pidQuarantineLeafRole = (
    path: string,
  ): "source" | "quarantine" | null => {
    const anchored = pidQuarantineAnchored(path);
    if (anchored?.leaf === null || anchored === null) return null;
    if (
      fs.pidQuarantinePidPath !== null
      && anchored.leaf === basename(fs.pidQuarantinePidPath)
    ) return "source";
    if (
      fs.pidQuarantinePath !== null
      && anchored.leaf === basename(fs.pidQuarantinePath)
    ) return "quarantine";
    return null;
  };
  return {
    ...original,
    chmodSync: (...args: unknown[]) => fs.passthrough
      ? Reflect.apply(original.chmodSync, original, args)
      : Reflect.apply(fs.chmod, fs, args),
    existsSync: (...args: unknown[]) => fs.passthrough
      ? Reflect.apply(original.existsSync, original, args)
      : Reflect.apply(fs.exists, fs, args),
    lstatSync: (...args: unknown[]) => {
      const path = args[0];
      if (
        fs.passthrough
        && typeof path === "string"
        && pidQuarantineLeafRole(path) === "quarantine"
        && !fs.pidQuarantineSourceUnlinked
        && pidQuarantineConsumeFault("quarantine-lstat-error")
      ) {
        const error = new Error("captured quarantine lstat failure") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      if (
        fs.passthrough
        && typeof path === "string"
        && pidQuarantineLeafRole(path) === "quarantine"
        && !fs.pidQuarantineSourceUnlinked
        && pidQuarantineConsumeFault("canonical-source-present")
      ) {
        const sourcePath = fs.pidQuarantinePidPath;
        if (sourcePath === null) throw new Error("captured PID quarantine source is missing");
        return Reflect.apply(original.lstatSync, original, [sourcePath, ...args.slice(1)]);
      }
      if (
        fs.passthrough
        && typeof path === "string"
        && pidQuarantineLeafRole(path) === "source"
        && fs.pidQuarantineSourceUnlinked
        && pidQuarantineConsumeFault("source-post-lstat-error")
      ) {
        const error = new Error("captured canonical source lstat failure") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      if (
        fs.passthrough
        && typeof path === "string"
        && pidQuarantineLeafRole(path) === "source"
        && fs.pidQuarantineSourceUnlinked
        && pidQuarantineConsumeFault("source-post-present")
      ) {
        const quarantinePath = fs.pidQuarantinePath;
        if (quarantinePath === null) throw new Error("captured PID quarantine is missing");
        return Reflect.apply(original.lstatSync, original, [quarantinePath, ...args.slice(1)]);
      }
      if (
        fs.passthrough
        && typeof path === "string"
        && fs.heldUnlinkObserved
        && heldAnchoredLeafMatches(path)
        && heldFaultEnabled("anchored-lstat-error")
      ) {
        consumeHeldFault("anchored-lstat-error");
        const error = new Error("captured anchored lstat failure") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      if (
        fs.passthrough
        && fs.terminalPathFault === "lstat-throw"
        && typeof path === "string"
        && path === fs.terminalPathFaultTarget
      ) {
        fs.terminalPathFaultCalls += 1;
        if (fs.terminalPathFaultCalls === fs.terminalPathFaultOrdinal) {
          throw new Error("captured lstat failure");
        }
      }
      return fs.passthrough
        ? Reflect.apply(original.lstatSync, original, args)
        : Reflect.apply(fs.lstat, fs, args);
    },
    mkdtempSync: (...args: unknown[]) => fs.passthrough
      ? Reflect.apply(original.mkdtempSync, original, args)
      : Reflect.apply(fs.mkdtemp, fs, args),
    readFileSync: (path: unknown, ...args: unknown[]) => {
      if (
        fs.passthrough
        && fs.tokenReadTarget !== null
        && (path === fs.tokenReadTarget
          || (typeof path === "number"
            && fs.descriptorPaths.get(path) === fs.tokenReadTarget))
      ) {
        fs.tokenContentReadCalls += 1;
      }
      return fs.passthrough || typeof path === "number"
        ? Reflect.apply(original.readFileSync, original, [path, ...args])
        : Reflect.apply(fs.read, fs, [path, ...args]);
    },
    readdirSync: (...args: unknown[]) => {
      const path = args[0];
      if (
        fs.passthrough
        && typeof path === "string"
        && path === fs.terminalPathFaultTarget
      ) {
        if (fs.terminalPathFault === "readdir-throw") {
          fs.terminalPathFaultCalls += 1;
          if (fs.terminalPathFaultCalls === fs.terminalPathFaultOrdinal) {
            throw new Error("captured readdir failure");
          }
        }
        if (fs.terminalPathFault === "readdir-empty") {
          fs.terminalPathFaultCalls += 1;
          if (fs.terminalPathFaultCalls === fs.terminalPathFaultOrdinal) return [""];
        }
        if (fs.terminalPathFault === "readdir-invalid") {
          fs.terminalPathFaultCalls += 1;
          if (fs.terminalPathFaultCalls === fs.terminalPathFaultOrdinal) return ["x"];
        }
      }
      return fs.passthrough
        ? Reflect.apply(original.readdirSync, original, args)
        : Reflect.apply(fs.readdir, fs, args);
    },
    readlinkSync: (...args: unknown[]) => {
      const path = args[0];
      if (
        fs.passthrough
        && typeof path === "string"
        && path === fs.terminalPathFaultTarget
      ) {
        if (fs.terminalPathFault === "readlink-throw") {
          fs.terminalPathFaultCalls += 1;
          if (fs.terminalPathFaultCalls === fs.terminalPathFaultOrdinal) {
            throw new Error("captured readlink failure");
          }
        }
        if (fs.terminalPathFault === "readlink-mismatch") {
          fs.terminalPathFaultCalls += 1;
          if (fs.terminalPathFaultCalls === fs.terminalPathFaultOrdinal) {
            return "socket:[54321]";
          }
        }
      }
      return Reflect.apply(original.readlinkSync, original, args);
    },
    realpathSync: (...args: unknown[]) => {
      const path = args[0];
      if (
        fs.passthrough
        && fs.terminalPathFault === "realpath-throw"
        && typeof path === "string"
        && path === fs.terminalPathFaultTarget
      ) {
        fs.terminalPathFaultCalls += 1;
        if (fs.terminalPathFaultCalls === fs.terminalPathFaultOrdinal) {
          throw new Error("captured realpath failure");
        }
      }
      if (
        fs.passthrough
        && typeof path === "string"
        && pidQuarantineAnchored(path)?.leaf === null
      ) {
        if (
          !fs.pidQuarantineSourceUnlinked
          && pidQuarantineConsumeFault("parent-realpath")
        ) return `${fs.pidQuarantineRoot ?? ""}.captured-parent-mismatch`;
        if (
          fs.pidQuarantineSourceUnlinked
          && pidQuarantineConsumeFault("parent-post-realpath")
        ) return `${fs.pidQuarantineRoot ?? ""}.captured-parent-mismatch`;
      }
      if (
        fs.passthrough
        && typeof path === "string"
        && heldAnchoredParentMatches(path)
      ) {
        fs.heldUnlinkParentRealpathCalls += 1;
        const fault = fs.heldUnlinkParentRealpathCalls === 1
          ? "parent-realpath"
          : "parent-post-realpath";
        if (heldFaultEnabled(fault)) {
          consumeHeldFault(fault);
          return `${heldParentPath() ?? ""}.captured-mismatch`;
        }
      }
      return fs.passthrough
        ? Reflect.apply(original.realpathSync, original, args)
        : Reflect.apply(fs.realpath, fs, args);
    },
    rmSync: (...args: unknown[]) => fs.passthrough
      ? Reflect.apply(original.rmSync, original, args)
      : Reflect.apply(fs.rm, fs, args),
    statSync: (...args: unknown[]) => fs.passthrough
      ? Reflect.apply(original.statSync, original, args)
      : Reflect.apply(fs.stat, fs, args),
    linkSync: (...args: unknown[]) => {
      const source = args[0];
      const target = args[1];
      if (
        fs.passthrough
        && typeof source === "string"
        && typeof target === "string"
        && pidQuarantineLeafRole(source) === "source"
        && pidQuarantineLeafRole(target) === "quarantine"
      ) {
        fs.pidQuarantineLinkCalls += 1;
        if (pidQuarantineConsumeFault("link-eexist")) {
          const error = new Error("captured quarantine exists") as NodeJS.ErrnoException;
          error.code = "EEXIST";
          throw error;
        }
        if (pidQuarantineConsumeFault("link-error")) {
          const error = new Error("captured quarantine link failure") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
      }
      return Reflect.apply(original.linkSync, original, args);
    },
    unlinkSync: (...args: unknown[]) => {
      const path = args[0];
      if (
        fs.passthrough
        && typeof path === "string"
        && pidQuarantineLeafRole(path) === "source"
      ) {
        if (pidQuarantineConsumeFault("source-unlink")) {
          throw new Error("captured PID quarantine source unlink failure");
        }
        const unlinkResult = Reflect.apply(original.unlinkSync, original, args);
        fs.pidQuarantineSourceUnlinked = true;
        return unlinkResult;
      }
      if (
        fs.passthrough
        && typeof path === "string"
        && heldAnchoredLeafMatches(path)
      ) {
        if (heldFaultEnabled("unlink")) {
          consumeHeldFault("unlink");
          throw new Error("captured anchored unlink failure");
        }
        fs.heldUnlinkObserved = true;
      }
      return fs.passthrough
        ? Reflect.apply(original.unlinkSync, original, args)
        : Reflect.apply(fs.unlink, fs, args);
    },
    writeFileSync: (...args: unknown[]) => fs.passthrough
      ? Reflect.apply(original.writeFileSync, original, args)
      : Reflect.apply(fs.write, fs, args),
    openSync: (...args: unknown[]) => {
      const path = args[0];
      let pidQuarantineRootMatch = 0;
      const pidQuarantineRole = fs.passthrough && typeof path === "string"
        ? pidQuarantineLeafRole(path)
        : null;
      if (
        fs.passthrough
        && typeof path === "string"
        && path === fs.pidQuarantineRoot
      ) {
        fs.pidQuarantineRootOpenCount += 1;
        pidQuarantineRootMatch = fs.pidQuarantineRootOpenCount;
        if (
          fs.pidQuarantineSourceUnlinked
          && pidQuarantineConsumeFault("canonical-parent-open")
        ) {
          throw new Error("captured canonical PID parent open failure");
        }
      }
      if (
        fs.passthrough
        && typeof path === "string"
        && path === fs.pidQuarantinePath
        && fs.pidQuarantineSourceUnlinked
        && pidQuarantineConsumeFault("postclose-quarantine-open")
      ) {
        throw new Error("captured post-close PID quarantine open failure");
      }
      if (pidQuarantineRole === "source") {
        const openOrdinal = fs.pidQuarantineSourceDescriptors.length + 1;
        if (
          (openOrdinal === 1 && pidQuarantineConsumeFault("source-open"))
          || (openOrdinal === 1
            && pidQuarantineConsumeFault("source-open-parent-close"))
          || (openOrdinal === 2 && pidQuarantineConsumeFault("source-reopen"))
        ) {
          throw new Error("captured PID quarantine source open failure");
        }
      }
      if (
        pidQuarantineRole === "quarantine"
        && pidQuarantineConsumeFault("quarantine-open")
      ) {
        throw new Error("captured PID quarantine leaf open failure");
      }
      if (
        fs.passthrough
        && typeof path === "string"
        && heldAnchoredLeafMatches(path)
        && heldFaultEnabled("target-open")
      ) {
        consumeHeldFault("target-open");
        const error = new Error("captured held target open failure") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      if (
        fs.passthrough
        && typeof path === "string"
        && path === heldParentPath()
        && fs.heldUnlinkObserved
        && heldFaultEnabled("canonical-open")
      ) {
        consumeHeldFault("canonical-open");
        const error = new Error("captured canonical parent open failure") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      let capturedOpenMatch: number | null = null;
      if (
        fs.passthrough
        && fs.capturedOpenFaultArmed
        && typeof path === "string"
        && path === fs.capturedOpenFaultTarget
      ) {
        fs.capturedOpenFaultMatchCount += 1;
        capturedOpenMatch = fs.capturedOpenFaultMatchCount;
        if (
          !fs.capturedOpenFaultConsumed
          && Number.isSafeInteger(fs.capturedOpenFaultOrdinal)
          && fs.capturedOpenFaultOrdinal > 0
          && capturedOpenMatch === fs.capturedOpenFaultOrdinal
        ) {
          fs.capturedOpenFaultConsumed = true;
          fs.capturedOpenFaultObservation?.(path, "fault", capturedOpenMatch, null);
          const error = new Error("captured open failure") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
      }
      const descriptor = Reflect.apply(original.openSync, original, args) as number;
      if (fs.passthrough && typeof path === "string") {
        fs.descriptorCloseCalls.delete(descriptor);
        fs.descriptorPaths.set(descriptor, path);
        fs.descriptorFstatCalls.set(descriptor, 0);
        fs.descriptorReadCalls.set(descriptor, 0);
        if (pidQuarantineRootMatch > 0) {
          if (fs.pidQuarantineSourceUnlinked) {
            fs.pidQuarantineCanonicalParentDescriptor = descriptor;
            fs.pidQuarantineDescriptorRoles.set(descriptor, "canonical-parent");
          } else if (pidQuarantineRootMatch === fs.pidQuarantineParentOpenOrdinal) {
            fs.pidQuarantineParentDescriptor = descriptor;
            fs.pidQuarantineDescriptorRoles.set(descriptor, "parent");
          }
        } else if (pidQuarantineRole === "source") {
          fs.pidQuarantineSourceDescriptors.push(descriptor);
          fs.pidQuarantineSourceOrdinals.set(
            descriptor,
            fs.pidQuarantineSourceDescriptors.length,
          );
          fs.pidQuarantineDescriptorRoles.set(descriptor, "source");
        } else if (pidQuarantineRole === "quarantine") {
          fs.pidQuarantineDescriptorRoles.set(descriptor, "quarantine");
        }
        if (path === fs.terminalTarget) {
          fs.terminalFaultMatchCount += 1;
          fs.terminalFaultDescriptors.set(descriptor, fs.terminalFaultMatchCount);
          if (
            fs.terminalFaultDescriptor === null
            && !fs.terminalFaultConsumed
            && Number.isSafeInteger(fs.terminalFaultOrdinal)
            && fs.terminalFaultOrdinal > 0
            && fs.terminalFaultMatchCount === fs.terminalFaultOrdinal
          ) {
            fs.terminalFaultDescriptor = descriptor;
          }
        }
        if (
          fs.capturedFstatFaultArmed
          && !fs.capturedFstatFaultConsumed
          && path === fs.capturedFstatFaultTarget
          && fs.capturedFstatFaultDescriptor === null
        ) {
          fs.capturedFstatFaultMatchCount += 1;
          if (
            Number.isSafeInteger(fs.capturedFstatFaultOrdinal)
            && fs.capturedFstatFaultOrdinal > 0
            && fs.capturedFstatFaultMatchCount === fs.capturedFstatFaultOrdinal
          ) {
            fs.capturedFstatFaultDescriptor = descriptor;
          }
        }
        if (capturedOpenMatch !== null) {
          fs.capturedOpenFaultDescriptors.set(descriptor, capturedOpenMatch);
          fs.capturedOpenFaultObservation?.(path, "open", capturedOpenMatch, descriptor);
        }
        if (path === fs.passiveOpenObservationTarget) {
          fs.passiveOpenObservationCount += 1;
          if (fs.passiveOpenObservationCount === fs.passiveOpenObservationOrdinal) {
            const observation = fs.passiveOpenObservation;
            fs.passiveOpenObservation = null;
            observation?.();
          }
        }
        if (heldAnchoredLeafMatches(path)) {
          fs.heldUnlinkTargetDescriptor = descriptor;
        } else if (path === heldParentPath() && fs.heldUnlinkObserved) {
          fs.heldUnlinkCanonicalDescriptor = descriptor;
        }
      }
      return descriptor;
    },
    readSync: (...args: unknown[]) => {
      const descriptor = args[0] as number;
      const descriptorPath = fs.descriptorPaths.get(descriptor);
      const pidQuarantineRole = fs.pidQuarantineDescriptorRoles.get(descriptor);
      const pidQuarantineReadCall = (fs.pidQuarantineReadCalls.get(descriptor) ?? 0) + 1;
      fs.pidQuarantineReadCalls.set(descriptor, pidQuarantineReadCall);
      if (
        fs.passthrough
        && pidQuarantineReadCall === 1
        && pidQuarantineRole === "source"
      ) {
        const sourceOrdinal = fs.pidQuarantineSourceOrdinals.get(descriptor) ?? 0;
        if (
          (sourceOrdinal === 1 && pidQuarantineConsumeFault("source-read"))
          || (sourceOrdinal === 2 && pidQuarantineConsumeFault("source-linked-read"))
        ) {
          throw new Error("captured PID quarantine source read failure");
        }
      }
      if (
        fs.passthrough
        && pidQuarantineReadCall === 1
        && pidQuarantineRole === "quarantine"
        && pidQuarantineConsumeFault("quarantine-linked-read")
      ) {
        throw new Error("captured PID quarantine leaf read failure");
      }
      const tokenRead = fs.passthrough && descriptorPath === fs.tokenReadTarget;
      if (tokenRead) {
        fs.tokenContentReadCalls += 1;
      }
      const call = (fs.descriptorReadCalls.get(descriptor) ?? 0) + 1;
      fs.descriptorReadCalls.set(descriptor, call);
      if (
        fs.passthrough
        && fs.descriptorPaths.get(descriptor) === fs.terminalEmptyDynamicTarget
      ) {
        fs.terminalEmptyDynamicReadCalls += 1;
        return 0;
      }
      if (
        fs.passthrough
        && descriptor === fs.terminalFaultDescriptor
        && fs.descriptorPaths.get(descriptor) === fs.terminalTarget
        && !fs.terminalFaultConsumed
        && call === 1
        && (fs.terminalFault === "invalid-negative-count"
          || fs.terminalFault === "invalid-overread-count")
      ) {
        fs.terminalFaultConsumed = true;
        fs.terminalInvalidRead?.();
        return fs.terminalFault === "invalid-negative-count"
          ? -1
          : (args[3] as number) + 1;
      }
      if (
        fs.passthrough
        && descriptor === fs.terminalFaultDescriptor
        && fs.descriptorPaths.get(descriptor) === fs.terminalTarget
      ) {
        if (fs.terminalFault === "early-eof") return 0;
        if (fs.terminalFault === "read-throw") throw new Error("captured read failure");
      }
      const count = Reflect.apply(original.readSync, original, args);
      const destination = args[1];
      const offset = args[2];
      if (
        fs.passthrough
        && fs.descriptorPaths.get(descriptor) === fs.terminalReadReplacementTarget
        && fs.terminalReadReplacementBytes !== null
        && Buffer.isBuffer(destination)
        && typeof offset === "number"
        && typeof count === "number"
        && count > 0
      ) {
        if (fs.terminalReadReplacementBytes.length !== count) {
          throw new Error("captured replacement length mismatch");
        }
        fs.terminalReadReplacementBytes.copy(destination, offset);
        fs.terminalReadReplacementCalls += 1;
      }
      if (tokenRead && count > 0 && descriptorPath !== undefined) {
        fs.tokenContentReadObservation?.(descriptorPath, fs.tokenContentReadCalls);
      }
      return count;
    },
    fstatSync: (...args: unknown[]) => {
      const descriptor = args[0] as number;
      const stats = Reflect.apply(original.fstatSync, original, args);
      const options = args[1];
      const pidQuarantineRole = fs.pidQuarantineDescriptorRoles.get(descriptor);
      const pidQuarantineFstatCall = (fs.pidQuarantineFstatCalls.get(descriptor) ?? 0) + 1;
      fs.pidQuarantineFstatCalls.set(descriptor, pidQuarantineFstatCall);
      if (
        fs.passthrough
        && options !== null
        && typeof options === "object"
        && Reflect.get(options, "bigint") === true
      ) {
        if (
          pidQuarantineRole === "parent"
          && pidQuarantineFstatCall === 1
          && pidQuarantineConsumeFault("parent-proof")
        ) {
          Reflect.set(stats, "mode", 0n);
        } else if (
          pidQuarantineRole === "parent"
          && pidQuarantineFstatCall === 2
          && pidQuarantineConsumeFault("parent-post-proof")
        ) {
          Reflect.set(stats, "ino", Reflect.get(stats, "ino") + 1n);
        } else if (
          pidQuarantineRole === "canonical-parent"
          && pidQuarantineFstatCall === 1
          && pidQuarantineConsumeFault("canonical-parent-proof")
        ) {
          Reflect.set(stats, "mode", 0n);
        }
      }
      if (fs.passthrough && pidQuarantineRole === "source") {
        const sourceOrdinal = fs.pidQuarantineSourceOrdinals.get(descriptor) ?? 0;
        if (
          sourceOrdinal === 1
          && pidQuarantineFstatCall <= 2
          && fs.pidQuarantineFault === "source-proof"
        ) {
          if (fs.pidQuarantineFaultCalls === 0) fs.pidQuarantineFaultCalls = 1;
          Reflect.set(stats, "ino", Reflect.get(stats, "ino") + 1);
        } else if (
          sourceOrdinal === 2
          && pidQuarantineFstatCall <= 2
          && fs.pidQuarantineFault === "source-linked-proof"
        ) {
          if (fs.pidQuarantineFaultCalls === 0) fs.pidQuarantineFaultCalls = 1;
          Reflect.set(stats, "ino", Reflect.get(stats, "ino") + 1);
        } else if (
          sourceOrdinal === 2
          && pidQuarantineFstatCall === 3
          && pidQuarantineConsumeFault("source-post-proof")
        ) {
          Reflect.set(stats, "nlink", 2n);
        }
      } else if (fs.passthrough && pidQuarantineRole === "quarantine") {
        if (
          pidQuarantineFstatCall <= 2
          && fs.pidQuarantineFault === "quarantine-linked-proof"
        ) {
          if (fs.pidQuarantineFaultCalls === 0) fs.pidQuarantineFaultCalls = 1;
          Reflect.set(stats, "ino", Reflect.get(stats, "ino") + 1);
        } else if (
          pidQuarantineFstatCall === 3
          && pidQuarantineConsumeFault("quarantine-post-proof")
        ) {
          Reflect.set(stats, "nlink", 2n);
        }
      }
      if (
        fs.passthrough
        && options !== null
        && typeof options === "object"
        && Reflect.get(options, "bigint") === true
      ) {
        const path = fs.descriptorPaths.get(descriptor);
        if (path === heldParentPath()) {
          if (fs.heldUnlinkParentDescriptor === null) {
            fs.heldUnlinkParentDescriptor = descriptor;
            fs.heldUnlinkNativeStartTokenReads = fs.tokenContentReadCalls;
          }
          if (descriptor === fs.heldUnlinkParentDescriptor) {
            fs.heldUnlinkParentFstatCalls += 1;
            const fault = fs.heldUnlinkParentFstatCalls === 1
              ? "parent-proof"
              : "parent-post-proof";
            if (heldFaultEnabled(fault)) {
              consumeHeldFault(fault);
              if (fault === "parent-proof") Reflect.set(stats, "mode", 0n);
              else Reflect.set(stats, "ino", Reflect.get(stats, "ino") + 1n);
            }
          } else {
            fs.heldUnlinkCanonicalDescriptor = descriptor;
            fs.heldUnlinkCanonicalFstatCalls += 1;
            if (heldFaultEnabled("canonical-proof")) {
              consumeHeldFault("canonical-proof");
              Reflect.set(stats, "mode", 0n);
            }
          }
        } else if (path !== undefined && heldAnchoredLeafMatches(path)) {
          fs.heldUnlinkTargetDescriptor = descriptor;
          fs.heldUnlinkTargetFstatCalls += 1;
          if (
            fs.heldUnlinkTargetFstatCalls === 2
            && heldFaultEnabled("target-post-proof-throw")
          ) {
            consumeHeldFault("target-post-proof-throw");
            throw new Error("captured held target post-unlink fstat failure");
          }
          const fault = fs.heldUnlinkTargetFstatCalls === 1
            ? "target-proof"
            : fs.heldUnlinkTargetFstatCalls === 2
              ? "target-post-proof"
              : null;
          if (fault !== null && heldFaultEnabled(fault)) {
            consumeHeldFault(fault);
            if (fault === "target-proof") Reflect.set(stats, "mode", 0n);
            else Reflect.set(stats, "nlink", 1n);
          }
        }
      }
      if (
        fs.passthrough
        && fs.descriptorPaths.get(descriptor) === fs.terminalEmptyDynamicTarget
      ) {
        return { ...stats, size: 0 };
      }
      if (
        fs.passthrough
        && fs.capturedFstatFaultArmed
        && !fs.capturedFstatFaultConsumed
        && descriptor === fs.capturedFstatFaultDescriptor
      ) {
        const alternateIno = fs.capturedFstatFaultIno
          ?? (stats.ino === Number.MAX_SAFE_INTEGER ? stats.ino - 1 : stats.ino + 1);
        fs.capturedFstatFaultIno = alternateIno;
        fs.capturedFstatFaultCount += 1;
        if (fs.capturedFstatFaultKind === "inode") stats.ino = alternateIno;
        else if (fs.capturedFstatFaultKind === "mode") stats.mode = 0;
        else if (fs.capturedFstatFaultKind === "nlink") stats.nlink = 2;
        else if (fs.capturedFstatFaultKind === "size-negative") stats.size = -1;
        else if (fs.capturedFstatFaultKind === "uid") stats.uid += 1;
        else if (fs.capturedFstatFaultCount === 2) stats.mtimeMs += 1;
        fs.capturedFstatFaultObservation?.(
          "fstat",
          fs.capturedFstatFaultTarget ?? "",
          descriptor,
          fs.capturedFstatFaultCount,
          alternateIno,
        );
        return stats;
      }
      if (
        fs.passthrough
        && descriptor === fs.terminalFaultDescriptor
        && fs.descriptorPaths.get(descriptor) === fs.terminalTarget
      ) {
        const call = (fs.descriptorFstatCalls.get(descriptor) ?? 0) + 1;
        fs.descriptorFstatCalls.set(descriptor, call);
        if (fs.terminalFault === "size-zero") return { ...stats, size: 0 };
        if (fs.terminalFault === "second-fstat-drift" && call === 2) {
          fs.terminalFaultConsumed = true;
          return { ...stats, mtimeMs: stats.mtimeMs + 1 };
        }
      }
      return stats;
    },
    closeSync: (...args: unknown[]) => {
      const descriptor = args[0] as number;
      const descriptorPath = fs.descriptorPaths.get(descriptor);
      const pidQuarantineRole = fs.pidQuarantineDescriptorRoles.get(descriptor);
      const capturedOpenMatch = fs.capturedOpenFaultDescriptors.get(descriptor);
      const targeted = fs.passthrough
        && descriptor === fs.terminalFaultDescriptor
        && descriptorPath === fs.terminalTarget;
      const capturedFstatPath = fs.capturedFstatFaultTarget;
      const capturedFstatTargeted = fs.passthrough
        && fs.capturedFstatFaultArmed
        && !fs.capturedFstatFaultConsumed
        && capturedFstatPath !== null
        && descriptor === fs.capturedFstatFaultDescriptor;
      const heldCloseFault = descriptor === fs.heldUnlinkCanonicalDescriptor
        ? "canonical-close"
        : descriptor === fs.heldUnlinkTargetDescriptor
          ? "target-close"
          : descriptor === fs.heldUnlinkParentDescriptor
            ? "parent-close"
            : null;
      const result = Reflect.apply(original.closeSync, original, args);
      fs.descriptorCloseCalls.add(descriptor);
      fs.descriptorPaths.delete(descriptor);
      fs.descriptorFstatCalls.delete(descriptor);
      fs.descriptorReadCalls.delete(descriptor);
      fs.terminalFaultDescriptors.delete(descriptor);
      fs.capturedOpenFaultDescriptors.delete(descriptor);
      fs.pidQuarantineDescriptorRoles.delete(descriptor);
      fs.pidQuarantineSourceOrdinals.delete(descriptor);
      fs.pidQuarantineFstatCalls.delete(descriptor);
      fs.pidQuarantineReadCalls.delete(descriptor);
      if (descriptorPath !== undefined && capturedOpenMatch !== undefined) {
        fs.capturedOpenFaultObservation?.(
          descriptorPath,
          "close",
          capturedOpenMatch,
          descriptor,
        );
      }
      if (capturedFstatTargeted) {
        fs.capturedFstatFaultObservation?.(
          "close",
          capturedFstatPath,
          descriptor,
          fs.capturedFstatFaultCount,
          null,
        );
        fs.capturedFstatFaultArmed = false;
        fs.capturedFstatFaultConsumed = true;
        fs.capturedFstatFaultTarget = null;
        fs.capturedFstatFaultDescriptor = null;
        fs.capturedFstatFaultIno = null;
      }
      if (targeted && !fs.terminalFaultConsumed && fs.terminalFault === "close-failure") {
        fs.terminalFaultConsumed = true;
        throw new Error("captured close failure");
      }
      const pidQuarantineCloseFault = pidQuarantineRole === "canonical-parent"
        ? "canonical-parent-close"
        : pidQuarantineRole === "quarantine"
          ? "quarantine-close"
          : pidQuarantineRole === "source" && fs.pidQuarantineSourceUnlinked
            ? "source-close"
            : pidQuarantineRole === "parent"
              ? "parent-close"
              : null;
      if (
        pidQuarantineCloseFault !== null
        && pidQuarantineConsumeFault(pidQuarantineCloseFault)
      ) {
        throw new Error(`captured ${pidQuarantineCloseFault} failure`);
      }
      if (
        pidQuarantineRole === "parent"
        && fs.pidQuarantineFault === "source-open-parent-close"
        && fs.pidQuarantineFaultCalls === 1
      ) {
        fs.pidQuarantineFaultCalls = 2;
        throw new Error("captured parent close after source-open failure");
      }
      if (heldCloseFault !== null && heldFaultEnabled(heldCloseFault)) {
        consumeHeldFault(heldCloseFault);
        throw new Error(`captured ${heldCloseFault} failure`);
      }
      if (
        fs.passthrough
        && fs.heldUnlinkObserved
        && descriptor === fs.heldUnlinkParentDescriptor
      ) {
        const observation = fs.heldUnlinkCompletionObservation;
        fs.heldUnlinkCompletionObservation = null;
        observation?.();
      }
      return result;
    },
    fchmodSync: (...args: unknown[]) => {
      const descriptor = args[0];
      if (
        fs.passthrough
        && typeof descriptor === "number"
        && fs.descriptorPaths.get(descriptor) === fs.terminalPathFaultTarget
        && fs.terminalPathFault === "fchmod-throw"
      ) {
        fs.terminalPathFaultCalls += 1;
        if (fs.terminalPathFaultCalls === fs.terminalPathFaultOrdinal) {
          throw new Error("captured fchmod failure");
        }
      }
      return Reflect.apply(original.fchmodSync, original, args);
    },
    fsyncSync: (...args: unknown[]) => {
      const descriptor = args[0];
      if (
        fs.passthrough
        && descriptor === fs.pidQuarantineParentDescriptor
        && fs.pidQuarantineSourceUnlinked
        && pidQuarantineConsumeFault("parent-fsync")
      ) {
        throw new Error("captured PID quarantine parent fsync failure");
      }
      if (
        fs.passthrough
        && descriptor === fs.heldUnlinkParentDescriptor
        && heldFaultEnabled("parent-fsync")
      ) {
        consumeHeldFault("parent-fsync");
        throw new Error("captured held parent fsync failure");
      }
      if (
        fs.passthrough
        && typeof descriptor === "number"
        && fs.descriptorPaths.get(descriptor) === fs.terminalPathFaultTarget
        && fs.terminalPathFault === "fsync-throw"
      ) {
        fs.terminalPathFaultCalls += 1;
        if (fs.terminalPathFaultCalls === fs.terminalPathFaultOrdinal) {
          throw new Error("captured fsync failure");
        }
      }
      return Reflect.apply(original.fsyncSync, original, args);
    },
    writeSync: (...args: unknown[]) => {
      const descriptor = args[0];
      if (
        fs.passthrough
        && typeof descriptor === "number"
        && fs.descriptorPaths.get(descriptor) === fs.terminalPathFaultTarget
      ) {
        if (fs.terminalPathFault === "write-throw") {
          fs.terminalPathFaultCalls += 1;
          if (fs.terminalPathFaultCalls === fs.terminalPathFaultOrdinal) {
            throw new Error("captured write failure");
          }
        }
        if (fs.terminalPathFault === "write-zero") {
          fs.terminalPathFaultCalls += 1;
          if (fs.terminalPathFaultCalls === fs.terminalPathFaultOrdinal) return 0;
        }
      }
      return Reflect.apply(original.writeSync, original, args);
    },
  };
});

import {
  __lifecycleTestUtils,
  ensureDaemon as ensureDaemonProduction,
  restartDaemon as restartDaemonProduction,
} from "../../src/daemon/lifecycle.js";
import type { DaemonLifecycleHermeticTestSeams } from "../../src/daemon/lifecycle-scope.js";

type EnsureDaemonOptions = Parameters<typeof ensureDaemonProduction>[0];
type SpawnOverride = NonNullable<EnsureDaemonOptions["_spawnOverride"]>;

const saved = {
  anthropic: process.env.ANTHROPIC_API_KEY,
  openai: process.env.OPENAI_API_KEY,
  lcm: process.env.LCM_SUMMARY_API_KEY,
  argv: [...process.argv],
};
const originalGetuid = Object.getOwnPropertyDescriptor(process, "getuid");
let runtimeRoot: string;
beforeEach(async () => {
  runtimeRoot = await mkdtemp(join(tmpdir(), "lcm-mocked-lifecycle-"));
  await mkdir(join(runtimeRoot, ".hermetic-runtime"));
  await mkdir(join(runtimeRoot, ".hermetic-credentials"));
  await mkdir(join(runtimeRoot, ".hermetic-proc"));
  await writeFile(join(runtimeRoot, "daemon.token"), "token", { mode: 0o600 });
  Object.defineProperty(process, "getuid", { configurable: true, value: vi.fn(() => 1000) });
  vi.clearAllMocks();
  fs.passthrough = false;
  fs.terminalFault = null;
  fs.terminalTarget = null;
  fs.terminalFaultDescriptor = null;
  fs.terminalFaultConsumed = false;
  fs.terminalFaultOrdinal = 1;
  fs.terminalFaultMatchCount = 0;
  fs.terminalFaultDescriptors.clear();
  fs.terminalInvalidRead = null;
  fs.terminalReadReplacementTarget = null;
  fs.terminalReadReplacementBytes = null;
  fs.terminalReadReplacementCalls = 0;
  fs.terminalEmptyDynamicTarget = null;
  fs.terminalEmptyDynamicReadCalls = 0;
  fs.terminalHashFault = null;
  fs.terminalHashFaultCalls = 0;
  fs.terminalPathFaultTarget = null;
  fs.terminalPathFault = null;
  fs.terminalPathFaultOrdinal = 1;
  fs.terminalPathFaultCalls = 0;
  fs.capturedOpenFaultTarget = null;
  fs.capturedOpenFaultArmed = false;
  fs.capturedOpenFaultConsumed = false;
  fs.capturedOpenFaultOrdinal = 1;
  fs.capturedOpenFaultMatchCount = 0;
  fs.capturedOpenFaultDescriptors.clear();
  fs.capturedOpenFaultObservation = null;
  fs.passiveOpenObservationTarget = null;
  fs.passiveOpenObservationOrdinal = 1;
  fs.passiveOpenObservationCount = 0;
  fs.passiveOpenObservation = null;
  fs.capturedFstatFaultTarget = null;
  fs.capturedFstatFaultDescriptor = null;
  fs.capturedFstatFaultArmed = false;
  fs.capturedFstatFaultConsumed = false;
  fs.capturedFstatFaultCount = 0;
  fs.capturedFstatFaultIno = null;
  fs.capturedFstatFaultOrdinal = 1;
  fs.capturedFstatFaultMatchCount = 0;
  fs.capturedFstatFaultKind = "inode";
  fs.capturedFstatFaultObservation = null;
  fs.tokenReadTarget = null;
  fs.tokenContentReadCalls = 0;
  fs.tokenContentReadObservation = null;
  fs.descriptorPaths.clear();
  fs.descriptorFstatCalls.clear();
  fs.descriptorReadCalls.clear();
  fs.descriptorCloseCalls.clear();
  fs.heldUnlinkTarget = null;
  fs.heldUnlinkFaults.clear();
  fs.heldUnlinkFaultCalls.clear();
  fs.heldUnlinkParentDescriptor = null;
  fs.heldUnlinkNativeStartTokenReads = null;
  fs.heldUnlinkTargetDescriptor = null;
  fs.heldUnlinkCanonicalDescriptor = null;
  fs.heldUnlinkParentFstatCalls = 0;
  fs.heldUnlinkTargetFstatCalls = 0;
  fs.heldUnlinkCanonicalFstatCalls = 0;
  fs.heldUnlinkParentRealpathCalls = 0;
  fs.heldUnlinkObserved = false;
  fs.heldUnlinkCompletionObservation = null;
  fs.pidQuarantineRoot = null;
  fs.pidQuarantinePidPath = null;
  fs.pidQuarantinePath = null;
  fs.pidQuarantineFault = null;
  fs.pidQuarantineFaultCalls = 0;
  fs.pidQuarantineRootOpenCount = 0;
  fs.pidQuarantineParentOpenOrdinal = 0;
  fs.pidQuarantineParentDescriptor = null;
  fs.pidQuarantineCanonicalParentDescriptor = null;
  fs.pidQuarantineSourceDescriptors.length = 0;
  fs.pidQuarantineSourceOrdinals.clear();
  fs.pidQuarantineDescriptorRoles.clear();
  fs.pidQuarantineFstatCalls.clear();
  fs.pidQuarantineReadCalls.clear();
  fs.pidQuarantineSourceUnlinked = false;
  fs.pidQuarantineLinkCalls = 0;
  fs.exists.mockImplementation((path: string) => path.endsWith("daemon.token"));
  fs.lstat.mockImplementation((path: string) => {
    if (
      basename(path) === ".daemon.pid.restart-recovery.json"
      || basename(path) === ".daemon.pid.restart-quarantine"
    ) {
      const error = new Error("missing") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    if (path.endsWith("daemon.pid") || path.endsWith("daemon.token")) {
      if (!fs.exists(path)) {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return {
        dev: 1,
        ino: 2,
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
        nlink: 1,
      };
    }
    return {
      dev: 1,
      ino: 1,
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false,
      nlink: 1,
    };
  });
  fs.mkdtemp.mockReturnValue(
    join(runtimeRoot, ".hermetic-credentials", "lcm-systemd-credentials-test"),
  );
  fs.realpath.mockImplementation((path: string) => path);
  fs.stat.mockReturnValue({ isDirectory: () => true, mtimeMs: 0 }); fs.readdir.mockReturnValue([]);
  delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.LCM_SUMMARY_API_KEY;
});
afterEach(async () => {
  fs.passthrough = false;
  fs.terminalFault = null;
  fs.terminalTarget = null;
  fs.terminalFaultDescriptor = null;
  fs.terminalFaultConsumed = false;
  fs.terminalFaultOrdinal = 1;
  fs.terminalFaultMatchCount = 0;
  fs.terminalFaultDescriptors.clear();
  fs.terminalInvalidRead = null;
  fs.terminalReadReplacementTarget = null;
  fs.terminalReadReplacementBytes = null;
  fs.terminalReadReplacementCalls = 0;
  fs.terminalEmptyDynamicTarget = null;
  fs.terminalEmptyDynamicReadCalls = 0;
  fs.terminalHashFault = null;
  fs.terminalHashFaultCalls = 0;
  fs.terminalPathFaultTarget = null;
  fs.terminalPathFault = null;
  fs.terminalPathFaultOrdinal = 1;
  fs.terminalPathFaultCalls = 0;
  fs.capturedOpenFaultTarget = null;
  fs.capturedOpenFaultArmed = false;
  fs.capturedOpenFaultConsumed = false;
  fs.capturedOpenFaultOrdinal = 1;
  fs.capturedOpenFaultMatchCount = 0;
  fs.capturedOpenFaultDescriptors.clear();
  fs.capturedOpenFaultObservation = null;
  fs.passiveOpenObservationTarget = null;
  fs.passiveOpenObservationOrdinal = 1;
  fs.passiveOpenObservationCount = 0;
  fs.passiveOpenObservation = null;
  fs.capturedFstatFaultTarget = null;
  fs.capturedFstatFaultDescriptor = null;
  fs.capturedFstatFaultArmed = false;
  fs.capturedFstatFaultConsumed = false;
  fs.capturedFstatFaultCount = 0;
  fs.capturedFstatFaultIno = null;
  fs.capturedFstatFaultOrdinal = 1;
  fs.capturedFstatFaultMatchCount = 0;
  fs.capturedFstatFaultKind = "inode";
  fs.capturedFstatFaultObservation = null;
  fs.tokenReadTarget = null;
  fs.tokenContentReadCalls = 0;
  fs.tokenContentReadObservation = null;
  fs.descriptorPaths.clear();
  fs.descriptorFstatCalls.clear();
  fs.descriptorReadCalls.clear();
  fs.descriptorCloseCalls.clear();
  fs.heldUnlinkTarget = null;
  fs.heldUnlinkFaults.clear();
  fs.heldUnlinkFaultCalls.clear();
  fs.heldUnlinkParentDescriptor = null;
  fs.heldUnlinkNativeStartTokenReads = null;
  fs.heldUnlinkTargetDescriptor = null;
  fs.heldUnlinkCanonicalDescriptor = null;
  fs.heldUnlinkParentFstatCalls = 0;
  fs.heldUnlinkTargetFstatCalls = 0;
  fs.heldUnlinkCanonicalFstatCalls = 0;
  fs.heldUnlinkParentRealpathCalls = 0;
  fs.heldUnlinkObserved = false;
  fs.heldUnlinkCompletionObservation = null;
  fs.pidQuarantineRoot = null;
  fs.pidQuarantinePidPath = null;
  fs.pidQuarantinePath = null;
  fs.pidQuarantineFault = null;
  fs.pidQuarantineFaultCalls = 0;
  fs.pidQuarantineRootOpenCount = 0;
  fs.pidQuarantineParentOpenOrdinal = 0;
  fs.pidQuarantineParentDescriptor = null;
  fs.pidQuarantineCanonicalParentDescriptor = null;
  fs.pidQuarantineSourceDescriptors.length = 0;
  fs.pidQuarantineSourceOrdinals.clear();
  fs.pidQuarantineDescriptorRoles.clear();
  fs.pidQuarantineFstatCalls.clear();
  fs.pidQuarantineReadCalls.clear();
  fs.pidQuarantineSourceUnlinked = false;
  fs.pidQuarantineLinkCalls = 0;
  process.argv.splice(0, process.argv.length, ...saved.argv);
  if (originalGetuid) Object.defineProperty(process, "getuid", originalGetuid);
  else Reflect.deleteProperty(process, "getuid");
  vi.restoreAllMocks();
  if (saved.anthropic === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.anthropic;
  if (saved.openai === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.openai;
  if (saved.lcm === undefined) delete process.env.LCM_SUMMARY_API_KEY; else process.env.LCM_SUMMARY_API_KEY = saved.lcm;
  await rm(runtimeRoot, { recursive: true, force: true });
});

const base = (): EnsureDaemonOptions => ({
  port: 1, pidFilePath: join(runtimeRoot, "daemon.pid"), spawnTimeoutMs: 1, expectedVersion: "1", _platform: "linux" as const,
  enforceUserManagerParent: true, _fetchOverride: vi.fn().mockRejectedValue(new Error("down")),
  _spawnOverride: vi.fn(() => ({ pid: undefined, once: vi.fn(), unref: vi.fn() })) as unknown as SpawnOverride,
  _monotonicNowOverride: (): number => 0,
  _skipHealthWait: true,
});

const writePidLeaf = (pid: number): void => {
  const descriptor = openSync(join(runtimeRoot, "daemon.pid"), "w", 0o600);
  try {
    writeSync(descriptor, String(pid));
  } finally {
    closeSync(descriptor);
  }
};

function readWithoutTokenAccounting<T>(read: () => T): T {
  const tokenReadTarget = fs.tokenReadTarget;
  fs.tokenReadTarget = null;
  try {
    return read();
  } finally {
    fs.tokenReadTarget = tokenReadTarget;
  }
}

function ensureDaemon(options: EnsureDaemonOptions): ReturnType<typeof ensureDaemonProduction> {
  const seams: DaemonLifecycleHermeticTestSeams = {
    homeDir: runtimeRoot,
    runtimeDir: join(runtimeRoot, ".hermetic-runtime"),
    stateDir: runtimeRoot,
    credentialDir: join(runtimeRoot, ".hermetic-credentials"),
    procRoot: join(runtimeRoot, ".hermetic-proc"),
    platform: options._platform ?? "linux",
    uid: options._uid ?? 1000,
    environment: { ...process.env },
    fetch: options._fetchOverride
      ?? (vi.fn().mockRejectedValue(new Error("hermetic offline")) as never),
    spawn: options._spawnOverride
      ?? (vi.fn(() => ({ pid: undefined, once: vi.fn().mockReturnThis(), unref: vi.fn() })) as never),
    spawnSync: options._spawnSyncOverride
      ?? (vi.fn(() => ({ status: 1, stdout: "", stderr: "hermetic" })) as never),
    stopUnit: vi.fn(),
    killProcess: options._killOverride ?? vi.fn(),
    isProcessAlive: options._isProcessAliveOverride ?? (() => false),
    sleep: options._sleepOverride ?? (async () => undefined),
    realpath: options._realpathOverride ?? (path => path),
  };
  return ensureDaemonProduction({ ...options, _hermeticTestSeams: seams });
}

type CapturedReaderFixture = Readonly<{
  root: string;
  procRoot: string;
  pidFile: string;
  tokenFile: string;
  entrypoint: string;
  runtimeDigest: string;
  killProcess: ReturnType<typeof vi.fn>;
  ensureReplacement: ReturnType<typeof vi.fn>;
  options: Parameters<typeof restartDaemonProduction>[0];
}>;

function createCapturedReaderFixture(): CapturedReaderFixture {
  fs.passthrough = true;
  const root = join(runtimeRoot, "captured-reader");
  const procRoot = join(root, "proc");
  const pidFile = join(root, "daemon.pid");
  const tokenFile = join(root, "daemon.token");
  const entrypoint = join(root, "lcm.mjs");
  const managerExecutable = join(root, "systemd");
  const managerPid = 3131;
  const originalPid = 4242;
  const replacementPid = 5252;
  const runtime = "console.log('captured reader runtime');\n";
  const runtimeDigest = createHash("sha256").update(runtime).digest("hex");
  const netRoot = join(procRoot, "net");
  mkdirSync(netRoot, { recursive: true });
  mkdirSync(join(root, ".hermetic-runtime"), { recursive: true });
  mkdirSync(join(root, ".hermetic-credentials"), { recursive: true });
  writeFileSync(entrypoint, runtime);
  writeFileSync(managerExecutable, "captured user manager\n");
  writeFileSync(pidFile, String(originalPid));
  chmodSync(pidFile, 0o644);
  writeFileSync(tokenFile, "local-token");
  chmodSync(tokenFile, 0o600);
  process.argv[1] = entrypoint;
  const tcpHeader = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode";
  const writeListener = (present: boolean): void => {
    writeFileSync(join(netRoot, "tcp"), [
      tcpHeader,
      ...(present
        ? ["   0: 0100007F:4E1F 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12345"]
        : []),
      "",
    ].join("\n"));
    writeFileSync(join(netRoot, "tcp6"), `${tcpHeader}\n`);
  };
  writeListener(false);

  const writeManager = (): void => {
    const directory = join(procRoot, String(managerPid));
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    const statFields = ["S", ...Array<string>(18).fill("0"), "313131"];
    writeFileSync(join(directory, "stat"), `${String(managerPid)} (systemd) ${statFields.join(" ")}\n`);
    writeFileSync(join(directory, "status"), "Name:\tsystemd\nUid:\t1000\t1000\t1000\t1000\nPPid:\t1\n");
    writeFileSync(join(directory, "cmdline"), `${managerExecutable}\0--user\0`);
    symlinkSync(managerExecutable, join(directory, "exe"));
  };
  writeManager();

  let originalAlive = true;
  let replacementAlive = false;
  const writeProcess = (pid: number, startTime: string): void => {
    const directory = join(procRoot, String(pid));
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    const statFields = ["S", ...Array<string>(18).fill("0"), startTime];
    const argv = [process.execPath, entrypoint, "daemon", "start", "--foreground"];
    writeFileSync(join(directory, "stat"), `${String(pid)} (node main) ${statFields.join(" ")}\n`);
    writeFileSync(
      join(directory, "status"),
      `Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nPPid:\t${String(managerPid)}\n`,
    );
    writeFileSync(join(directory, "cmdline"), `${argv.join("\0")}\0`);
    symlinkSync(process.execPath, join(directory, "exe"));
    if (pid === replacementPid) {
      replacementAlive = true;
      const fdDirectory = join(directory, "fd");
      mkdirSync(fdDirectory);
      symlinkSync("socket:[12345]", join(fdDirectory, "7"));
      writeListener(true);
    }
  };
  writeProcess(originalPid, "123456");

  const killProcess = vi.fn((_pid: number, signal?: NodeJS.Signals | number): void => {
    if (signal !== "SIGTERM") return;
    originalAlive = false;
    rmSync(join(procRoot, String(originalPid)), { recursive: true, force: true });
    rmSync(pidFile, { force: true });
    writeListener(false);
  });
  const isAlive = (pid: number): boolean => (
    (pid === originalPid && originalAlive) || (pid === replacementPid && replacementAlive)
  );
  const ensureReplacement = vi.fn(async () => {
    writeFileSync(pidFile, String(replacementPid));
    chmodSync(pidFile, 0o644);
    writeProcess(replacementPid, "654321");
    return { connected: true, port: 19999, spawned: true, pid: replacementPid };
  });
  const healthFetch = vi.fn(async (input: string | URL | Request) => {
    if (!replacementAlive) throw new Error("health connection failed");
    if (String(input).endsWith("/stats/pool")) {
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: "ok",
        version: "1.4.2",
        storageBackend: "sqlite",
        pid: replacementPid,
        entrypoint,
        runtimeDigest,
      }),
    } as Response;
  });
  const lifecycleSeams: DaemonLifecycleHermeticTestSeams = {
    homeDir: root,
    runtimeDir: join(root, ".hermetic-runtime"),
    stateDir: root,
    credentialDir: join(root, ".hermetic-credentials"),
    procRoot,
    platform: "linux",
    uid: 1000,
    environment: {},
    fetch: healthFetch as never,
    spawn: vi.fn(() => ({ pid: undefined, once: vi.fn(), unref: vi.fn() })) as never,
    spawnSync: vi.fn(() => ({ status: 1, stdout: "", stderr: "hermetic" })) as never,
    stopUnit: vi.fn(),
    killProcess,
    isProcessAlive: isAlive,
    sleep: async () => undefined,
    realpath: realpathSync,
  };
  const options: Parameters<typeof restartDaemonProduction>[0] = {
    port: 19999,
    pidFilePath: pidFile,
    spawnTimeoutMs: 100,
    expectedEntrypoint: entrypoint,
    expectedRuntimeDigest: runtimeDigest,
    expectedVersion: "1.4.2",
    _packagedEntrypointOverride: entrypoint,
    _platform: "linux",
    _procRoot: procRoot,
    _uid: 1000,
    _realpathOverride: realpathSync,
    _fetchOverride: healthFetch as never,
    _listeningPortsOverride: (pid?: number) => (
      pid === replacementPid ? (replacementAlive ? [19999] : []) : [19999]
    ),
    _isProcessAliveOverride: isAlive,
    _killOverride: killProcess,
    _sleepOverride: async () => undefined,
    _ensureDaemonOverride: ensureReplacement,
    _hermeticTestSeams: lifecycleSeams,
  };
  return {
    root,
    procRoot,
    pidFile,
    tokenFile,
    entrypoint,
    runtimeDigest,
    killProcess,
    ensureReplacement,
    options,
  };
}

function terminalChangedStartTime(path: string): Buffer {
  const bytes = readFileSync(path);
  const index = bytes.length - 2;
  if (index < 0) throw new Error("captured stat content is empty");
  const original = bytes[index];
  if (original === undefined || original < 48 || original > 57) {
    throw new Error("captured stat start time is not decimal");
  }
  bytes[index] = original === 48 ? 49 : 48;
  return bytes;
}

function terminalParserReplacement(
  path: string,
  mutation: "header-mismatch" | "hex-invalid" | "hex-lowercase" | "inode-mismatch"
    | "short-data" | "short-header" | "sl-mismatch" | "stat-missing-start"
    | "status-cr" | "status-short-line" | "status-token-mismatch"
    | "status-value-overrun" | "too-many-tokens" | "uid-mismatch" | "wildcard",
): Buffer {
  const bytes = readFileSync(path);
  const locate = (needle: string): number => {
    const index = bytes.indexOf(needle);
    if (index < 0) throw new Error(`captured terminal token is missing: ${needle}`);
    return index;
  };
  if (mutation === "stat-missing-start") {
    const commandEnd = locate(")");
    bytes.fill(32, commandEnd + 1);
    Buffer.from(" S 0\n").copy(bytes, commandEnd + 1);
  } else if (mutation === "status-short-line") {
    bytes[0] = 120;
    bytes[1] = 10;
  } else if (mutation === "status-value-overrun") {
    const uid = locate("Uid:\t1000");
    bytes[uid + 6] = 10;
  } else if (mutation === "status-token-mismatch") {
    const uid = locate("Uid:\t1000");
    bytes[uid + 5] = 50;
  } else if (mutation === "status-cr") {
    const uid = locate("Uid:\t1000\t");
    bytes[uid + 9] = 13;
  } else if (mutation === "header-mismatch") {
    bytes[locate("local_address")] = 120;
  } else if (mutation === "short-header") {
    bytes.fill(32);
    Buffer.from("sl local\n").copy(bytes);
  } else if (mutation === "sl-mismatch") {
    const headerEnd = locate("\n");
    const dataStart = headerEnd + 1;
    while (dataStart < bytes.length && bytes[dataStart] === 32) {
      bytes.copyWithin(dataStart, dataStart + 1);
    }
    bytes[dataStart] = 120;
  } else if (mutation === "hex-lowercase") {
    bytes[locate("0100007F") + 7] = 102;
  } else if (mutation === "hex-invalid") {
    bytes[locate("0100007F") + 7] = 71;
  } else if (mutation === "wildcard") {
    Buffer.from("00000000").copy(bytes, locate("0100007F"));
  } else if (mutation === "uid-mismatch") {
    const uid = locate(" 1000 0 12345") + 1;
    bytes[uid + 3] = 49;
  } else if (mutation === "inode-mismatch") {
    Buffer.from("54321").copy(bytes, locate("12345"));
  } else if (mutation === "short-data") {
    const dataStart = locate("\n") + 1;
    bytes.fill(32, dataStart);
    Buffer.from("0 1 2\n").copy(bytes, dataStart);
  } else {
    bytes.fill(32);
    const overflowing = Buffer.from(`${Array.from({ length: 33 }, () => "x").join(" ")}\n`);
    if (overflowing.length > bytes.length) {
      throw new Error("captured tcp content is too short for the token overflow");
    }
    overflowing.copy(bytes);
  }
  return bytes;
}

describe("mocked systemd credential boundaries", () => {
  it("starts with no secret credentials", async () => {
    const spawnSync = vi.fn(() => ({ status: 0 }));
    const result = await ensureDaemon({ ...base(), _spawnSyncOverride: spawnSync as never });
    expect(result.startMethod).toBe("systemd-user");
    expect(fs.mkdtemp).not.toHaveBeenCalled();
  });

  it("reports an unavailable uid", async () => {
    process.env.ANTHROPIC_API_KEY = "secret";
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
    try {
      expect(() => __lifecycleTestUtils.systemdDaemonCredentialArgs(process.env))
        .toThrow("current user id is unavailable");
    } finally {
      if (descriptor) Object.defineProperty(process, "getuid", descriptor);
    }
  });

  it("uses only the current user's production credential root without a test scope", () => {
    process.env.ANTHROPIC_API_KEY = "secret";
    const credentials = __lifecycleTestUtils.systemdDaemonCredentialArgs(process.env);
    expect(fs.stat).toHaveBeenCalledWith("/run/user/1000");
    expect(credentials.args).toEqual([
      expect.stringContaining(
        `ANTHROPIC_API_KEY:${join(runtimeRoot, ".hermetic-credentials")}/`,
      ),
    ]);
    credentials.cleanup?.();
    expect(fs.rm).toHaveBeenCalledWith(
      join(runtimeRoot, ".hermetic-credentials", "lcm-systemd-credentials-test"),
      { recursive: true, force: true },
    );
  });

  it("reports a non-directory runtime path", async () => {
    process.env.ANTHROPIC_API_KEY = "secret";
    fs.stat.mockReturnValue({ isDirectory: () => false, mtimeMs: 0 });
    const result = await ensureDaemon(base());
    expect(result.warning).toContain("credential setup error: process reported a failure");
  });

  it("cleans a partially created credential directory after write failure", async () => {
    process.env.ANTHROPIC_API_KEY = "secret";
    fs.readdir.mockReturnValue([
      { isDirectory: () => false, name: "file" },
      { isDirectory: () => true, name: "other" },
      { isDirectory: () => true, name: "lcm-systemd-credentials-old" },
    ]);
    fs.write.mockImplementation((path: string) => {
      if (path.includes("lcm-systemd-credentials-test")) throw "write failed";
    });
    const result = await ensureDaemon(base());
    expect(result.warning).toContain("credential setup error: process reported a failure");
    expect(fs.rm).toHaveBeenCalledWith(
      join(runtimeRoot, ".hermetic-credentials", "lcm-systemd-credentials-test"),
      { recursive: true, force: true },
    );
  });

  it("does not attempt partial cleanup when credential directory creation fails", async () => {
    process.env.ANTHROPIC_API_KEY = "secret";
    fs.mkdtemp.mockImplementation(() => { throw new Error("mkdir failed"); });
    const result = await ensureDaemon(base());
    expect(result.warning).toContain("credential setup error: process reported a failure");
    expect(fs.rm).not.toHaveBeenCalledWith(
      join(runtimeRoot, ".hermetic-credentials", "lcm-systemd-credentials-test"),
      expect.anything(),
    );
  });

  it("tolerates cleanup scan stat/removal failures", async () => {
    process.env.ANTHROPIC_API_KEY = "secret";
    fs.readdir.mockReturnValue([{ isDirectory: () => true, name: "lcm-systemd-credentials-old" }]);
    fs.stat.mockImplementation((path: string) => path === join(runtimeRoot, ".hermetic-credentials")
      ? { isDirectory: () => true, mtimeMs: 0 }
      : (() => { throw new Error("stat"); })());
    fs.write.mockImplementation(() => {});
    const result = await ensureDaemon({ ...base(), _spawnSyncOverride: vi.fn(() => ({ status: 0 })) as never });
    expect(result.startMethod).toBe("systemd-user");
    expect(fs.rm).toHaveBeenCalledWith(
      join(runtimeRoot, ".hermetic-credentials", "lcm-systemd-credentials-test"),
      { recursive: true, force: true },
    );
  });

  it("cleans credentials after a systemd-started daemon becomes healthy", async () => {
    process.env.ANTHROPIC_API_KEY = "secret";
    process.env.LCM_SUMMARY_API_KEY = "summary-secret";
    fs.read.mockImplementation((path: string) => {
      if (path.endsWith("daemon.token")) return "token";
      if (path.endsWith("daemon.pid")) return "20";
      throw new Error(`unexpected read ${path}`);
    });
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error("initially down"))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "1", pid: 20 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok", version: "1", pid: 20 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const result = await ensureDaemon({
      ...base(), _skipHealthWait: false, _fetchOverride: fetch,
      _spawnSyncOverride: vi.fn(() => {
        writePidLeaf(20);
        fs.exists.mockReturnValue(true);
        return { status: 0 };
      }) as never,
      _sleepOverride: async () => {},
      expectedVersion: "1", _isProcessAliveOverride: () => true, _listeningPortsOverride: () => [1],
    });
    expect(result).toMatchObject({ connected: true, startMethod: "systemd-user" });
    expect(fs.rm).toHaveBeenCalledWith(
      join(runtimeRoot, ".hermetic-credentials", "lcm-systemd-credentials-test"),
      { recursive: true, force: true },
    );
  });

  it("tolerates credential cleanup removal failures and Error-valued systemd throws", async () => {
    process.env.ANTHROPIC_API_KEY = "secret";
    fs.rm.mockImplementation(() => { throw new Error("remove"); });
    const result = await ensureDaemon({
      ...base(),
      _spawnSyncOverride: vi.fn(() => { throw new Error("systemd error"); }) as never,
    });
    expect(result.warning).toContain("systemd start exception: process reported a failure");
  });

  it("does not terminate when a verified retry PID changes identity before signaling", async () => {
    let daemonCommandReads = 0;
    writePidLeaf(20);
    fs.exists.mockReturnValue(true);
    fs.readdir.mockReturnValue([{ isDirectory: () => true, name: "11" }]);
    fs.read.mockImplementation((path: string) => {
      if (path.endsWith("daemon.pid")) return "20";
      if (path.endsWith("/11/status")) return "Uid:\t1000\nPPid:\t1\n";
      if (path.endsWith("/11/cmdline")) return "systemd\0--user";
      if (path.endsWith("/20/status")) return "Uid:\t1000\nPPid:\t10\n";
      if (path.endsWith("/20/cmdline")) {
        daemonCommandReads++;
        return daemonCommandReads === 1 ? "node\0lcm\0daemon\0start\0--foreground" : "node\0other";
      }
      if (path.endsWith("daemon.token")) return "token";
      throw new Error(`unexpected read ${path}`);
    });
    const kill = vi.fn();
    const result = await ensureDaemon({
      ...base(), _procRoot: "/proc", _uid: 1000, _skipSpawn: true, _skipHealthWait: false,
      _isProcessAliveOverride: () => true, _killOverride: kill, _sleepOverride: async () => {},
    });
    expect(result.connected).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it("does not terminate when an existing healthy PID changes identity before signaling", async () => {
    let daemonCommandReads = 0;
    writePidLeaf(20);
    fs.exists.mockImplementation((path: string) => path.endsWith("daemon.token"));
    fs.readdir.mockReturnValue([{ isDirectory: () => true, name: "10" }]);
    fs.read.mockImplementation((path: string) => {
      if (path.endsWith("daemon.pid")) return "20";
      if (path.endsWith("/10/status")) return "Uid:\t1000\nPPid:\t1\n";
      if (path.endsWith("/10/cmdline")) return "systemd\0--user";
      if (path.endsWith("/20/status")) return "Uid:\t1000\nPPid:\t10\n";
      if (path.endsWith("/20/cmdline")) return ++daemonCommandReads === 1 ? "node\0lcm\0daemon\0start" : "node\0other";
      if (path.endsWith("daemon.token")) return "token";
      throw new Error(`unexpected read ${path}`);
    });
    const fetch = vi.fn(async (url: string) => url.endsWith("/health")
      ? { ok: true, json: async () => ({ status: "ok", pid: 20 }) }
      : { ok: true, json: async () => ({}) });
    const kill = vi.fn();
    const result = await ensureDaemon({
      ...base(), _procRoot: "/proc", _uid: 1000, _skipSpawn: true, _skipHealthWait: false,
      _fetchOverride: fetch as never, _isProcessAliveOverride: () => true, _killOverride: kill,
    });
    expect(result.connected).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it("does not signal when a wrong-parent first inspection becomes unavailable on reinspection", async () => {
    writePidLeaf(20);
    fs.exists.mockImplementation((path: string) => path.endsWith("daemon.token"));
    fs.readdir.mockReturnValue([{ isDirectory: () => true, name: "11" }]);
    fs.read.mockImplementation((path: string) => {
      if (path.endsWith("daemon.pid")) return "20";
      if (path.endsWith("/11/status")) return "Uid:\t1000\nPPid:\t1\n";
      if (path.endsWith("/11/cmdline")) return "systemd\0--user";
      if (path.endsWith("/20/status")) return "Uid:\t1000\nPPid:\t10\n";
      if (path.endsWith("/20/cmdline")) {
        writePidLeaf(Number.NaN);
        return "node\0lcm\0daemon\0start";
      }
      if (path.endsWith("daemon.token")) return "token";
      throw new Error(`unexpected read ${path}`);
    });
    const fetch = vi.fn(async (url: string) => url.endsWith("/health")
      ? { ok: true, json: async () => ({ status: "ok", pid: 20 }) }
      : { ok: true, json: async () => ({}) });
    const kill = vi.fn();
    const result = await ensureDaemon({
      ...base(), _procRoot: "/proc", _uid: 1000, _skipSpawn: true, _skipHealthWait: false,
      _fetchOverride: fetch as never, _isProcessAliveOverride: () => true, _killOverride: kill,
    });
    expect(result.connected).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it("refuses authorized ensure when the second direct-root proof loses the exact credential directory", async () => {
    type ExactLeafSnapshot = Readonly<{
      bytes: Buffer;
      dev: number;
      ino: number;
      mode: number;
      uid: number;
      nlink: number;
      size: number;
      mtimeMs: number;
      ctimeMs: number;
    }>;
    const exactLeafSnapshot = (path: string): ExactLeafSnapshot | null => {
      try {
        const stats = lstatSync(path);
        if (!stats.isFile() || stats.isSymbolicLink()) {
          throw new Error(`expected exact regular file at ${path}`);
        }
        return {
          bytes: readFileSync(path),
          dev: stats.dev,
          ino: stats.ino,
          mode: stats.mode,
          uid: stats.uid,
          nlink: stats.nlink,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          ctimeMs: stats.ctimeMs,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    };

    const fixture = createCapturedReaderFixture();
    const hermeticSeams = fixture.options._hermeticTestSeams;
    if (hermeticSeams === undefined) throw new Error("captured hermetic seams are unavailable");
    const credentialDir = join(fixture.root, ".hermetic-credentials");
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    const credentialBefore = lstatSync(credentialDir);
    const pidBefore = exactLeafSnapshot(fixture.pidFile);
    const tokenBefore = exactLeafSnapshot(fixture.tokenFile);
    const recordBefore = exactLeafSnapshot(recordPath);
    const quarantineBefore = exactLeafSnapshot(quarantinePath);
    const spawn = vi.fn(
      () => ({ pid: undefined, once: vi.fn(), unref: vi.fn() }),
    ) as unknown as SpawnOverride;
    const lifecycleMutation = vi.fn();
    const boundaries: string[] = [];
    const faultObservations: string[] = [];
    let recordAtBoundary: ExactLeafSnapshot | null | undefined;
    let quarantineAtBoundary: ExactLeafSnapshot | null | undefined;
    let pidAtBoundary: ExactLeafSnapshot | null | undefined;
    let tokenAtBoundary: ExactLeafSnapshot | null | undefined;
    let signalCallsAtBoundary: number | undefined;
    let ensureCallsAtBoundary: number | undefined;
    let spawnCallsAtBoundary: number | undefined;
    let tokenReadsAtBoundary: number | undefined;
    let mutationCallsAtBoundary: number | undefined;
    let signalCallsAtFault: number | undefined;
    let ensureCallsAtFault: number | undefined;
    let spawnCallsAtFault: number | undefined;
    let tokenReadsAtFault: number | undefined;
    let mutationCallsAtFault: number | undefined;
    let faultConsumed = false;
    let faultArmed = false;
    let tokenReadsAfter = 0;
    let result: Awaited<ReturnType<typeof restartDaemonProduction>> | undefined;
    let restartError: unknown;

    fs.tokenReadTarget = fixture.tokenFile;
    fs.capturedOpenFaultObservation = (path: string): void => {
      faultObservations.push(path);
      signalCallsAtFault = fixture.killProcess.mock.calls.length;
      ensureCallsAtFault = fixture.ensureReplacement.mock.calls.length;
      spawnCallsAtFault = spawn.mock.calls.length;
      tokenReadsAtFault = fs.tokenContentReadCalls;
      mutationCallsAtFault = lifecycleMutation.mock.calls.length;
    };

    try {
      result = await restartDaemonProduction({
        ...fixture.options,
        _hermeticTestSeams: {
          ...hermeticSeams,
          spawn,
        },
        _offlinePidUnlinkOverride: (path: string): void => {
          lifecycleMutation("pid-unlink", path);
        },
        _offlineRecordUnlinkOverride: (path: string): void => {
          lifecycleMutation("record-unlink", path);
        },
        _offlineRecoveryBackupUnlinkOverride: (path: string): void => {
          lifecycleMutation("backup-unlink", path);
        },
        _offlineRecoveryFinalizeOverride: (): void => {
          lifecycleMutation("finalize");
        },
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          boundaries.push(phase);
          if (phase !== "before-authorized-ensure") return;
          recordAtBoundary = exactLeafSnapshot(recordPath);
          quarantineAtBoundary = exactLeafSnapshot(quarantinePath);
          pidAtBoundary = exactLeafSnapshot(fixture.pidFile);
          tokenAtBoundary = readWithoutTokenAccounting(
            () => exactLeafSnapshot(fixture.tokenFile),
          );
          signalCallsAtBoundary = fixture.killProcess.mock.calls.length;
          ensureCallsAtBoundary = fixture.ensureReplacement.mock.calls.length;
          spawnCallsAtBoundary = spawn.mock.calls.length;
          tokenReadsAtBoundary = fs.tokenContentReadCalls;
          mutationCallsAtBoundary = lifecycleMutation.mock.calls.length;
          expect(fs.capturedOpenFaultConsumed).toBe(false);
          fs.capturedOpenFaultTarget = credentialDir;
          fs.capturedOpenFaultArmed = true;
        },
      });
    } catch (error) {
      restartError = error;
    } finally {
      faultConsumed = fs.capturedOpenFaultConsumed;
      faultArmed = fs.capturedOpenFaultArmed;
      tokenReadsAfter = fs.tokenContentReadCalls;
      fs.capturedOpenFaultTarget = null;
      fs.capturedOpenFaultArmed = false;
      fs.capturedOpenFaultConsumed = false;
      fs.capturedOpenFaultObservation = null;
      fs.tokenReadTarget = null;
      fs.tokenContentReadCalls = 0;
    }

    const credentialAfter = lstatSync(credentialDir);
    const recordAfter = exactLeafSnapshot(recordPath);
    const quarantineAfter = exactLeafSnapshot(quarantinePath);
    const pidAfter = exactLeafSnapshot(fixture.pidFile);
    const tokenAfter = exactLeafSnapshot(fixture.tokenFile);

    expect(result).toBeUndefined();
    expect(restartError).toEqual(expect.any(Error));
    expect((restartError as Error).message).toContain(
      "final replacement-startup boundary",
    );
    expect(boundaries.filter(phase => phase === "before-authorized-ensure")).toHaveLength(1);
    expect(faultObservations).toEqual([credentialDir]);
    expect(faultConsumed).toBe(true);
    expect(faultArmed).toBe(true);
    expect(realpathSync(credentialDir)).toBe(credentialDir);
    expect({
      dev: credentialAfter.dev,
      ino: credentialAfter.ino,
      mode: credentialAfter.mode,
      uid: credentialAfter.uid,
      nlink: credentialAfter.nlink,
    }).toEqual({
      dev: credentialBefore.dev,
      ino: credentialBefore.ino,
      mode: credentialBefore.mode,
      uid: credentialBefore.uid,
      nlink: credentialBefore.nlink,
    });
    expect(credentialAfter.isDirectory()).toBe(true);
    expect(credentialAfter.isSymbolicLink()).toBe(false);
    expect(pidBefore).not.toBeNull();
    expect(tokenBefore).not.toBeNull();
    expect(recordBefore).toBeNull();
    expect(quarantineBefore).toBeNull();
    expect(recordAtBoundary).not.toBeNull();
    expect(recordAtBoundary?.mode ?? 0).toSatisfy((mode: number) => (mode & 0o077) === 0);
    expect(recordAfter).toEqual(recordAtBoundary);
    expect(quarantineAtBoundary).toBeNull();
    expect(quarantineAfter).toEqual(quarantineAtBoundary);
    expect(pidAtBoundary).toBeNull();
    expect(pidAfter).toEqual(pidAtBoundary);
    expect(tokenAtBoundary).toEqual(tokenBefore);
    expect(tokenAfter).toEqual(tokenAtBoundary);
    expect(signalCallsAtBoundary).toBeGreaterThan(0);
    expect(signalCallsAtFault).toBe(signalCallsAtBoundary);
    expect(fixture.killProcess).toHaveBeenCalledTimes(signalCallsAtBoundary ?? -1);
    expect(ensureCallsAtBoundary).toBe(0);
    expect(ensureCallsAtFault).toBe(ensureCallsAtBoundary);
    expect(fixture.ensureReplacement).toHaveBeenCalledTimes(ensureCallsAtBoundary ?? -1);
    expect(spawnCallsAtBoundary).toBe(0);
    expect(spawnCallsAtFault).toBe(spawnCallsAtBoundary);
    expect(spawn).toHaveBeenCalledTimes(spawnCallsAtBoundary ?? -1);
    expect(tokenReadsAtBoundary).toBe(0);
    expect(tokenReadsAtFault).toBe(tokenReadsAtBoundary);
    expect(tokenReadsAfter).toBe(tokenReadsAtBoundary);
    expect(mutationCallsAtFault).toBe(mutationCallsAtBoundary);
    expect(lifecycleMutation).toHaveBeenCalledTimes(mutationCallsAtBoundary ?? -1);
    expect(boundaries).not.toContain("after-replacement-readiness");
    expect(boundaries).not.toContain("before-record-proof");
    expect(boundaries).not.toContain("before-record-cleanup");
    expect(boundaries).not.toContain("before-terminal-restart-publication");
    expect(lifecycleMutation).not.toHaveBeenCalledWith("finalize");
  });

  it("refuses authorized ensure when the second direct-root proof loses the exact proc root", async () => {
    type ExactLeafSnapshot = Readonly<{
      bytes: Buffer;
      dev: number;
      ino: number;
      mode: number;
      uid: number;
      nlink: number;
      size: number;
      mtimeMs: number;
      ctimeMs: number;
    }>;
    const exactLeafSnapshot = (path: string): ExactLeafSnapshot | null => {
      try {
        const stats = lstatSync(path);
        if (!stats.isFile() || stats.isSymbolicLink()) {
          throw new Error(`expected exact regular file at ${path}`);
        }
        return {
          bytes: readFileSync(path),
          dev: stats.dev,
          ino: stats.ino,
          mode: stats.mode,
          uid: stats.uid,
          nlink: stats.nlink,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          ctimeMs: stats.ctimeMs,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    };

    const fixture = createCapturedReaderFixture();
    const hermeticSeams = fixture.options._hermeticTestSeams;
    if (hermeticSeams === undefined) throw new Error("captured hermetic seams are unavailable");
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    const procRootBefore = lstatSync(fixture.procRoot);
    const pidBefore = exactLeafSnapshot(fixture.pidFile);
    const tokenBefore = exactLeafSnapshot(fixture.tokenFile);
    const recordBefore = exactLeafSnapshot(recordPath);
    const quarantineBefore = exactLeafSnapshot(quarantinePath);
    const spawn = vi.fn(
      () => ({ pid: undefined, once: vi.fn(), unref: vi.fn() }),
    ) as unknown as SpawnOverride;
    const lifecycleMutation = vi.fn();
    const boundaries: string[] = [];
    const faultObservations: string[] = [];
    let recordAtBoundary: ExactLeafSnapshot | null | undefined;
    let quarantineAtBoundary: ExactLeafSnapshot | null | undefined;
    let pidAtBoundary: ExactLeafSnapshot | null | undefined;
    let tokenAtBoundary: ExactLeafSnapshot | null | undefined;
    let signalCallsAtBoundary: number | undefined;
    let ensureCallsAtBoundary: number | undefined;
    let spawnCallsAtBoundary: number | undefined;
    let tokenReadsAtBoundary: number | undefined;
    let mutationCallsAtBoundary: number | undefined;
    let descriptorsAtBoundary: number | undefined;
    let signalCallsAtFault: number | undefined;
    let ensureCallsAtFault: number | undefined;
    let spawnCallsAtFault: number | undefined;
    let tokenReadsAtFault: number | undefined;
    let mutationCallsAtFault: number | undefined;
    let descriptorsAtFault: number | undefined;
    let exactTargetDescriptorAtFault = false;
    let faultConsumed = false;
    let faultArmed = false;
    let tokenReadsAfter = 0;
    let descriptorsAfter = 0;
    let result: Awaited<ReturnType<typeof restartDaemonProduction>> | undefined;
    let restartError: unknown;

    fs.tokenReadTarget = fixture.tokenFile;
    fs.capturedOpenFaultObservation = (path: string): void => {
      faultObservations.push(path);
      signalCallsAtFault = fixture.killProcess.mock.calls.length;
      ensureCallsAtFault = fixture.ensureReplacement.mock.calls.length;
      spawnCallsAtFault = spawn.mock.calls.length;
      tokenReadsAtFault = fs.tokenContentReadCalls;
      mutationCallsAtFault = lifecycleMutation.mock.calls.length;
      descriptorsAtFault = fs.descriptorPaths.size;
      exactTargetDescriptorAtFault = [...fs.descriptorPaths.values()].includes(path);
    };

    try {
      result = await restartDaemonProduction({
        ...fixture.options,
        _hermeticTestSeams: {
          ...hermeticSeams,
          spawn,
        },
        _offlinePidUnlinkOverride: (path: string): void => {
          lifecycleMutation("pid-unlink", path);
        },
        _offlineRecordUnlinkOverride: (path: string): void => {
          lifecycleMutation("record-unlink", path);
        },
        _offlineRecoveryBackupUnlinkOverride: (path: string): void => {
          lifecycleMutation("backup-unlink", path);
        },
        _offlineRecoveryFinalizeOverride: (): void => {
          lifecycleMutation("finalize");
        },
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          boundaries.push(phase);
          if (phase !== "before-authorized-ensure") return;
          recordAtBoundary = exactLeafSnapshot(recordPath);
          quarantineAtBoundary = exactLeafSnapshot(quarantinePath);
          pidAtBoundary = exactLeafSnapshot(fixture.pidFile);
          tokenAtBoundary = readWithoutTokenAccounting(
            () => exactLeafSnapshot(fixture.tokenFile),
          );
          signalCallsAtBoundary = fixture.killProcess.mock.calls.length;
          ensureCallsAtBoundary = fixture.ensureReplacement.mock.calls.length;
          spawnCallsAtBoundary = spawn.mock.calls.length;
          tokenReadsAtBoundary = fs.tokenContentReadCalls;
          mutationCallsAtBoundary = lifecycleMutation.mock.calls.length;
          descriptorsAtBoundary = fs.descriptorPaths.size;
          expect(fs.capturedOpenFaultConsumed).toBe(false);
          fs.capturedOpenFaultTarget = fixture.procRoot;
          fs.capturedOpenFaultArmed = true;
        },
      });
    } catch (error) {
      restartError = error;
    } finally {
      faultConsumed = fs.capturedOpenFaultConsumed;
      faultArmed = fs.capturedOpenFaultArmed;
      tokenReadsAfter = fs.tokenContentReadCalls;
      descriptorsAfter = fs.descriptorPaths.size;
      fs.capturedOpenFaultTarget = null;
      fs.capturedOpenFaultArmed = false;
      fs.capturedOpenFaultConsumed = false;
      fs.capturedOpenFaultObservation = null;
      fs.tokenReadTarget = null;
      fs.tokenContentReadCalls = 0;
    }

    const procRootAfter = lstatSync(fixture.procRoot);
    const recordAfter = exactLeafSnapshot(recordPath);
    const quarantineAfter = exactLeafSnapshot(quarantinePath);
    const pidAfter = exactLeafSnapshot(fixture.pidFile);
    const tokenAfter = exactLeafSnapshot(fixture.tokenFile);

    expect(result).toBeUndefined();
    expect(restartError).toEqual(expect.any(Error));
    expect((restartError as Error).message).toContain(
      "final replacement-startup boundary",
    );
    expect(boundaries.filter(phase => phase === "before-authorized-ensure")).toHaveLength(1);
    expect(faultObservations).toEqual([fixture.procRoot]);
    expect(faultConsumed).toBe(true);
    expect(faultArmed).toBe(true);
    expect(descriptorsAtBoundary).toBe(0);
    expect(descriptorsAtFault).toBe(0);
    expect(exactTargetDescriptorAtFault).toBe(false);
    expect(descriptorsAfter).toBe(0);
    expect(fs.descriptorPaths.size).toBe(0);
    expect(realpathSync(fixture.procRoot)).toBe(fixture.procRoot);
    expect({
      dev: procRootAfter.dev,
      ino: procRootAfter.ino,
      mode: procRootAfter.mode,
      uid: procRootAfter.uid,
    }).toEqual({
      dev: procRootBefore.dev,
      ino: procRootBefore.ino,
      mode: procRootBefore.mode,
      uid: procRootBefore.uid,
    });
    expect(procRootAfter.isDirectory()).toBe(true);
    expect(procRootAfter.isSymbolicLink()).toBe(false);
    expect(pidBefore).not.toBeNull();
    expect(tokenBefore).not.toBeNull();
    expect(recordBefore).toBeNull();
    expect(quarantineBefore).toBeNull();
    expect(recordAtBoundary).not.toBeNull();
    expect(recordAtBoundary?.mode ?? 0).toSatisfy((mode: number) => (mode & 0o077) === 0);
    expect(recordAfter).toEqual(recordAtBoundary);
    expect(quarantineAtBoundary).toBeNull();
    expect(quarantineAfter).toEqual(quarantineAtBoundary);
    expect(pidAtBoundary).toBeNull();
    expect(pidAfter).toEqual(pidAtBoundary);
    expect(tokenAtBoundary).toEqual(tokenBefore);
    expect(tokenAfter).toEqual(tokenAtBoundary);
    expect(signalCallsAtBoundary).toBeGreaterThan(0);
    expect(signalCallsAtFault).toBe(signalCallsAtBoundary);
    expect(fixture.killProcess).toHaveBeenCalledTimes(signalCallsAtBoundary ?? -1);
    expect(ensureCallsAtBoundary).toBe(0);
    expect(ensureCallsAtFault).toBe(ensureCallsAtBoundary);
    expect(fixture.ensureReplacement).toHaveBeenCalledTimes(ensureCallsAtBoundary ?? -1);
    expect(spawnCallsAtBoundary).toBe(0);
    expect(spawnCallsAtFault).toBe(spawnCallsAtBoundary);
    expect(spawn).toHaveBeenCalledTimes(spawnCallsAtBoundary ?? -1);
    expect(tokenReadsAtBoundary).toBe(0);
    expect(tokenReadsAtFault).toBe(tokenReadsAtBoundary);
    expect(tokenReadsAfter).toBe(tokenReadsAtBoundary);
    expect(mutationCallsAtFault).toBe(mutationCallsAtBoundary);
    expect(lifecycleMutation).toHaveBeenCalledTimes(mutationCallsAtBoundary ?? -1);
    expect(boundaries).not.toContain("after-replacement-readiness");
    expect(boundaries).not.toContain("before-record-proof");
    expect(boundaries).not.toContain("before-record-cleanup");
    expect(boundaries).not.toContain("before-terminal-restart-publication");
    expect(lifecycleMutation).not.toHaveBeenCalledWith("finalize");
  });

  it("refuses authorized ensure when the second entrypoint proof is omitted", async () => {
    type ExactLeafSnapshot = Readonly<{
      bytes: Buffer;
      dev: number;
      ino: number;
      mode: number;
      uid: number;
      nlink: number;
      size: number;
      mtimeMs: number;
      ctimeMs: number;
    }>;
    type OpenFaultObservation = Readonly<{
      path: string;
      event: "open" | "close" | "fault";
      ordinal: number;
      descriptor: number | null;
      descriptorTracked: boolean;
    }>;
    const exactLeafSnapshot = (path: string): ExactLeafSnapshot | null => {
      try {
        const stats = lstatSync(path);
        if (!stats.isFile() || stats.isSymbolicLink()) {
          throw new Error(`expected exact regular file at ${path}`);
        }
        return {
          bytes: readFileSync(path),
          dev: stats.dev,
          ino: stats.ino,
          mode: stats.mode,
          uid: stats.uid,
          nlink: stats.nlink,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          ctimeMs: stats.ctimeMs,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    };

    const fixture = createCapturedReaderFixture();
    const hermeticSeams = fixture.options._hermeticTestSeams;
    if (hermeticSeams === undefined) throw new Error("captured hermetic seams are unavailable");
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    const procRootBefore = lstatSync(fixture.procRoot);
    const entrypointBefore = exactLeafSnapshot(fixture.entrypoint);
    const pidBefore = exactLeafSnapshot(fixture.pidFile);
    const tokenBefore = exactLeafSnapshot(fixture.tokenFile);
    const recordBefore = exactLeafSnapshot(recordPath);
    const quarantineBefore = exactLeafSnapshot(quarantinePath);
    const spawn = vi.fn(
      () => ({ pid: undefined, once: vi.fn(), unref: vi.fn() }),
    ) as unknown as SpawnOverride;
    const lifecycleMutation = vi.fn();
    const boundaries: string[] = [];
    const faultObservations: OpenFaultObservation[] = [];
    let recordAtBoundary: ExactLeafSnapshot | null | undefined;
    let quarantineAtBoundary: ExactLeafSnapshot | null | undefined;
    let pidAtBoundary: ExactLeafSnapshot | null | undefined;
    let tokenAtBoundary: ExactLeafSnapshot | null | undefined;
    let entrypointAtBoundary: ExactLeafSnapshot | null | undefined;
    let signalCallsAtBoundary: number | undefined;
    let ensureCallsAtBoundary: number | undefined;
    let spawnCallsAtBoundary: number | undefined;
    let tokenReadsAtBoundary: number | undefined;
    let mutationCallsAtBoundary: number | undefined;
    let descriptorsAtBoundary: number | undefined;
    let signalCallsAtFault: number | undefined;
    let ensureCallsAtFault: number | undefined;
    let spawnCallsAtFault: number | undefined;
    let tokenReadsAtFault: number | undefined;
    let mutationCallsAtFault: number | undefined;
    let descriptorsAtFault: number | undefined;
    let ordinalStateAfter: Readonly<{
      ordinal: number;
      matches: number;
      armed: boolean;
      consumed: boolean;
      descriptors: number;
    }> | undefined;
    let tokenReadsAfter = 0;
    let descriptorsAfter = 0;
    let result: Awaited<ReturnType<typeof restartDaemonProduction>> | undefined;
    let restartError: unknown;

    fs.tokenReadTarget = fixture.tokenFile;
    fs.capturedOpenFaultObservation = (
      path: string,
      event: "open" | "close" | "fault",
      ordinal: number,
      descriptor: number | null,
    ): void => {
      faultObservations.push({
        path,
        event,
        ordinal,
        descriptor,
        descriptorTracked: descriptor !== null && fs.descriptorPaths.has(descriptor),
      });
      if (event !== "fault") return;
      signalCallsAtFault = fixture.killProcess.mock.calls.length;
      ensureCallsAtFault = fixture.ensureReplacement.mock.calls.length;
      spawnCallsAtFault = spawn.mock.calls.length;
      tokenReadsAtFault = fs.tokenContentReadCalls;
      mutationCallsAtFault = lifecycleMutation.mock.calls.length;
      descriptorsAtFault = fs.descriptorPaths.size;
    };

    try {
      result = await restartDaemonProduction({
        ...fixture.options,
        _hermeticTestSeams: {
          ...hermeticSeams,
          spawn,
        },
        _offlinePidUnlinkOverride: (path: string): void => {
          lifecycleMutation("pid-unlink", path);
        },
        _offlineRecordUnlinkOverride: (path: string): void => {
          lifecycleMutation("record-unlink", path);
        },
        _offlineRecoveryBackupUnlinkOverride: (path: string): void => {
          lifecycleMutation("backup-unlink", path);
        },
        _offlineRecoveryFinalizeOverride: (): void => {
          lifecycleMutation("finalize");
        },
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          boundaries.push(phase);
          if (phase !== "before-authorized-ensure") return;
          recordAtBoundary = exactLeafSnapshot(recordPath);
          quarantineAtBoundary = exactLeafSnapshot(quarantinePath);
          pidAtBoundary = exactLeafSnapshot(fixture.pidFile);
          tokenAtBoundary = readWithoutTokenAccounting(
            () => exactLeafSnapshot(fixture.tokenFile),
          );
          entrypointAtBoundary = exactLeafSnapshot(fixture.entrypoint);
          signalCallsAtBoundary = fixture.killProcess.mock.calls.length;
          ensureCallsAtBoundary = fixture.ensureReplacement.mock.calls.length;
          spawnCallsAtBoundary = spawn.mock.calls.length;
          tokenReadsAtBoundary = fs.tokenContentReadCalls;
          mutationCallsAtBoundary = lifecycleMutation.mock.calls.length;
          descriptorsAtBoundary = fs.descriptorPaths.size;
          expect(fs.capturedOpenFaultConsumed).toBe(false);
          expect(fs.capturedOpenFaultMatchCount).toBe(0);
          fs.capturedOpenFaultTarget = fixture.entrypoint;
          fs.capturedOpenFaultOrdinal = 3;
          fs.capturedOpenFaultArmed = true;
        },
      });
    } catch (error) {
      restartError = error;
    } finally {
      ordinalStateAfter = {
        ordinal: fs.capturedOpenFaultOrdinal,
        matches: fs.capturedOpenFaultMatchCount,
        armed: fs.capturedOpenFaultArmed,
        consumed: fs.capturedOpenFaultConsumed,
        descriptors: fs.capturedOpenFaultDescriptors.size,
      };
      tokenReadsAfter = fs.tokenContentReadCalls;
      descriptorsAfter = fs.descriptorPaths.size;
      fs.capturedOpenFaultTarget = null;
      fs.capturedOpenFaultArmed = false;
      fs.capturedOpenFaultConsumed = false;
      fs.capturedOpenFaultOrdinal = 1;
      fs.capturedOpenFaultMatchCount = 0;
      fs.capturedOpenFaultDescriptors.clear();
      fs.capturedOpenFaultObservation = null;
      fs.tokenReadTarget = null;
      fs.tokenContentReadCalls = 0;
    }

    const procRootAfter = lstatSync(fixture.procRoot);
    const entrypointAfter = exactLeafSnapshot(fixture.entrypoint);
    const recordAfter = exactLeafSnapshot(recordPath);
    const quarantineAfter = exactLeafSnapshot(quarantinePath);
    const pidAfter = exactLeafSnapshot(fixture.pidFile);
    const tokenAfter = exactLeafSnapshot(fixture.tokenFile);
    const openObservations = faultObservations.filter(({ event }) => event === "open");
    const closeObservations = faultObservations.filter(({ event }) => event === "close");
    const thrownObservations = faultObservations.filter(({ event }) => event === "fault");

    expect(result).toBeUndefined();
    expect(restartError).toEqual(expect.any(Error));
    expect((restartError as Error).message).toContain(
      "final replacement-startup boundary",
    );
    expect(boundaries.filter(phase => phase === "before-authorized-ensure")).toHaveLength(1);
    expect(faultObservations.map(({ event, ordinal }) => `${event}:${String(ordinal)}`)).toEqual([
      "open:1",
      "close:1",
      "open:2",
      "close:2",
      "fault:3",
    ]);
    expect(faultObservations.every(({ path }) => path === fixture.entrypoint)).toBe(true);
    expect(openObservations.map(({ ordinal }) => ordinal)).toEqual([1, 2]);
    expect(closeObservations.map(({ ordinal }) => ordinal)).toEqual([1, 2]);
    expect(thrownObservations).toHaveLength(1);
    expect(thrownObservations[0]).toMatchObject({
      ordinal: 3,
      descriptor: null,
      descriptorTracked: false,
    });
    for (const opened of openObservations) {
      expect(opened.descriptor).not.toBeNull();
      expect(opened.descriptorTracked).toBe(true);
      expect(closeObservations).toContainEqual(expect.objectContaining({
        ordinal: opened.ordinal,
        descriptor: opened.descriptor,
        descriptorTracked: false,
      }));
    }
    expect(ordinalStateAfter).toEqual({
      ordinal: 3,
      matches: 3,
      armed: true,
      consumed: true,
      descriptors: 0,
    });
    expect(descriptorsAtBoundary).toBe(0);
    expect(descriptorsAtFault).toBe(0);
    expect(descriptorsAfter).toBe(0);
    expect(fs.descriptorPaths.size).toBe(0);
    expect(realpathSync(fixture.procRoot)).toBe(fixture.procRoot);
    expect({
      dev: procRootAfter.dev,
      ino: procRootAfter.ino,
      mode: procRootAfter.mode,
      uid: procRootAfter.uid,
    }).toEqual({
      dev: procRootBefore.dev,
      ino: procRootBefore.ino,
      mode: procRootBefore.mode,
      uid: procRootBefore.uid,
    });
    expect(procRootAfter.isDirectory()).toBe(true);
    expect(procRootAfter.isSymbolicLink()).toBe(false);
    expect(entrypointBefore).not.toBeNull();
    expect(entrypointAtBoundary).toEqual(entrypointBefore);
    expect(entrypointAfter).toEqual(entrypointAtBoundary);
    expect(createHash("sha256").update(entrypointAfter?.bytes ?? Buffer.alloc(0)).digest("hex"))
      .toBe(fixture.runtimeDigest);
    for (const directory of [
      fixture.root,
      join(fixture.root, ".hermetic-runtime"),
      join(fixture.root, ".hermetic-credentials"),
      fixture.procRoot,
    ]) {
      expect(realpathSync(directory)).toBe(directory);
      const stats = lstatSync(directory);
      expect(stats.isDirectory()).toBe(true);
      expect(stats.isSymbolicLink()).toBe(false);
    }
    expect(pidBefore).not.toBeNull();
    expect(tokenBefore).not.toBeNull();
    expect(recordBefore).toBeNull();
    expect(quarantineBefore).toBeNull();
    expect(recordAtBoundary).not.toBeNull();
    expect(recordAtBoundary?.mode ?? 0).toSatisfy((mode: number) => (mode & 0o077) === 0);
    expect(recordAfter).toEqual(recordAtBoundary);
    expect(quarantineAtBoundary).toBeNull();
    expect(quarantineAfter).toEqual(quarantineAtBoundary);
    expect(pidAtBoundary).toBeNull();
    expect(pidAfter).toEqual(pidAtBoundary);
    expect(tokenAtBoundary).toEqual(tokenBefore);
    expect(tokenAfter).toEqual(tokenAtBoundary);
    expect(signalCallsAtBoundary).toBeGreaterThan(0);
    expect(signalCallsAtFault).toBe(signalCallsAtBoundary);
    expect(fixture.killProcess).toHaveBeenCalledTimes(signalCallsAtBoundary ?? -1);
    expect(ensureCallsAtBoundary).toBe(0);
    expect(ensureCallsAtFault).toBe(ensureCallsAtBoundary);
    expect(fixture.ensureReplacement).toHaveBeenCalledTimes(ensureCallsAtBoundary ?? -1);
    expect(spawnCallsAtBoundary).toBe(0);
    expect(spawnCallsAtFault).toBe(spawnCallsAtBoundary);
    expect(spawn).toHaveBeenCalledTimes(spawnCallsAtBoundary ?? -1);
    expect(tokenReadsAtBoundary).toBe(0);
    expect(tokenReadsAtFault).toBe(tokenReadsAtBoundary);
    expect(tokenReadsAfter).toBe(tokenReadsAtBoundary);
    expect(mutationCallsAtFault).toBe(mutationCallsAtBoundary);
    expect(lifecycleMutation).toHaveBeenCalledTimes(mutationCallsAtBoundary ?? -1);
    expect(boundaries).not.toContain("after-replacement-readiness");
    expect(boundaries).not.toContain("before-record-proof");
    expect(boundaries).not.toContain("before-record-cleanup");
    expect(boundaries).not.toContain("before-terminal-restart-publication");
    expect(lifecycleMutation).not.toHaveBeenCalledWith("finalize");
  });

  it("refuses authorized ensure when the second direct-root proof changes the exact credential inode", async () => {
    type ExactLeafSnapshot = Readonly<{
      bytes: Buffer;
      dev: number;
      ino: number;
      mode: number;
      uid: number;
      nlink: number;
      size: number;
      mtimeMs: number;
      ctimeMs: number;
    }>;
    type FstatFaultObservation = Readonly<{
      event: "fstat" | "close";
      path: string;
      descriptor: number;
      count: number;
      inode: number | null;
    }>;
    const exactLeafSnapshot = (path: string): ExactLeafSnapshot | null => {
      try {
        const stats = lstatSync(path);
        if (!stats.isFile() || stats.isSymbolicLink()) {
          throw new Error(`expected exact regular file at ${path}`);
        }
        return {
          bytes: readFileSync(path),
          dev: stats.dev,
          ino: stats.ino,
          mode: stats.mode,
          uid: stats.uid,
          nlink: stats.nlink,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          ctimeMs: stats.ctimeMs,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    };

    const fixture = createCapturedReaderFixture();
    const hermeticSeams = fixture.options._hermeticTestSeams;
    if (hermeticSeams === undefined) throw new Error("captured hermetic seams are unavailable");
    const credentialDir = join(fixture.root, ".hermetic-credentials");
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    const credentialBefore = lstatSync(credentialDir);
    const pidBefore = exactLeafSnapshot(fixture.pidFile);
    const tokenBefore = exactLeafSnapshot(fixture.tokenFile);
    const recordBefore = exactLeafSnapshot(recordPath);
    const quarantineBefore = exactLeafSnapshot(quarantinePath);
    const spawn = vi.fn(
      () => ({ pid: undefined, once: vi.fn(), unref: vi.fn() }),
    ) as unknown as SpawnOverride;
    const lifecycleMutation = vi.fn();
    const boundaries: string[] = [];
    const faultObservations: FstatFaultObservation[] = [];
    let recordAtBoundary: ExactLeafSnapshot | null | undefined;
    let quarantineAtBoundary: ExactLeafSnapshot | null | undefined;
    let pidAtBoundary: ExactLeafSnapshot | null | undefined;
    let tokenAtBoundary: ExactLeafSnapshot | null | undefined;
    let signalCallsAtBoundary: number | undefined;
    let ensureCallsAtBoundary: number | undefined;
    let spawnCallsAtBoundary: number | undefined;
    let tokenReadsAtBoundary: number | undefined;
    let mutationCallsAtBoundary: number | undefined;
    let faultStateAfter: Readonly<{
      target: string | null;
      descriptor: number | null;
      armed: boolean;
      consumed: boolean;
      count: number;
      inode: number | null;
    }> | undefined;
    let tokenReadsAfter = 0;
    let result: Awaited<ReturnType<typeof restartDaemonProduction>> | undefined;
    let restartError: unknown;

    fs.tokenReadTarget = fixture.tokenFile;
    fs.capturedFstatFaultObservation = (
      event: "fstat" | "close",
      path: string,
      descriptor: number,
      count: number,
      inode: number | null,
    ): void => {
      faultObservations.push({ event, path, descriptor, count, inode });
    };

    try {
      result = await restartDaemonProduction({
        ...fixture.options,
        _hermeticTestSeams: {
          ...hermeticSeams,
          spawn,
        },
        _offlinePidUnlinkOverride: (path: string): void => {
          lifecycleMutation("pid-unlink", path);
        },
        _offlineRecordUnlinkOverride: (path: string): void => {
          lifecycleMutation("record-unlink", path);
        },
        _offlineRecoveryBackupUnlinkOverride: (path: string): void => {
          lifecycleMutation("backup-unlink", path);
        },
        _offlineRecoveryFinalizeOverride: (): void => {
          lifecycleMutation("finalize");
        },
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          boundaries.push(phase);
          if (phase !== "before-authorized-ensure") return;
          recordAtBoundary = exactLeafSnapshot(recordPath);
          quarantineAtBoundary = exactLeafSnapshot(quarantinePath);
          pidAtBoundary = exactLeafSnapshot(fixture.pidFile);
          tokenAtBoundary = readWithoutTokenAccounting(
            () => exactLeafSnapshot(fixture.tokenFile),
          );
          signalCallsAtBoundary = fixture.killProcess.mock.calls.length;
          ensureCallsAtBoundary = fixture.ensureReplacement.mock.calls.length;
          spawnCallsAtBoundary = spawn.mock.calls.length;
          tokenReadsAtBoundary = fs.tokenContentReadCalls;
          mutationCallsAtBoundary = lifecycleMutation.mock.calls.length;
          expect(fs.capturedFstatFaultDescriptor).toBeNull();
          expect(fs.capturedFstatFaultConsumed).toBe(false);
          expect(fs.capturedFstatFaultCount).toBe(0);
          fs.capturedFstatFaultTarget = credentialDir;
          fs.capturedFstatFaultArmed = true;
        },
      });
    } catch (error) {
      restartError = error;
    } finally {
      faultStateAfter = {
        target: fs.capturedFstatFaultTarget,
        descriptor: fs.capturedFstatFaultDescriptor,
        armed: fs.capturedFstatFaultArmed,
        consumed: fs.capturedFstatFaultConsumed,
        count: fs.capturedFstatFaultCount,
        inode: fs.capturedFstatFaultIno,
      };
      tokenReadsAfter = fs.tokenContentReadCalls;
      fs.capturedFstatFaultTarget = null;
      fs.capturedFstatFaultDescriptor = null;
      fs.capturedFstatFaultArmed = false;
      fs.capturedFstatFaultConsumed = false;
      fs.capturedFstatFaultCount = 0;
      fs.capturedFstatFaultIno = null;
      fs.capturedFstatFaultObservation = null;
      fs.tokenReadTarget = null;
      fs.tokenContentReadCalls = 0;
    }

    const credentialAfter = lstatSync(credentialDir);
    const recordAfter = exactLeafSnapshot(recordPath);
    const quarantineAfter = exactLeafSnapshot(quarantinePath);
    const pidAfter = exactLeafSnapshot(fixture.pidFile);
    const tokenAfter = exactLeafSnapshot(fixture.tokenFile);
    const fstatObservations = faultObservations.filter(({ event }) => event === "fstat");
    const closeObservations = faultObservations.filter(({ event }) => event === "close");
    const observedDescriptors = new Set(faultObservations.map(({ descriptor }) => descriptor));
    const alteredInodes = fstatObservations.map(({ inode }) => inode);

    expect(result).toBeUndefined();
    expect(restartError).toEqual(expect.any(Error));
    expect((restartError as Error).message).toContain(
      "final replacement-startup boundary",
    );
    expect(boundaries.filter(phase => phase === "before-authorized-ensure")).toHaveLength(1);
    expect(faultStateAfter).toEqual({
      target: null,
      descriptor: null,
      armed: false,
      consumed: true,
      count: 2,
      inode: null,
    });
    expect(fstatObservations).toHaveLength(2);
    expect(closeObservations).toHaveLength(1);
    expect(faultObservations.map(({ event }) => event)).toEqual(["fstat", "fstat", "close"]);
    expect(faultObservations.every(({ path }) => path === credentialDir)).toBe(true);
    expect(observedDescriptors.size).toBe(1);
    expect(fstatObservations.map(({ count }) => count)).toEqual([1, 2]);
    expect(closeObservations[0]?.count).toBe(2);
    expect(alteredInodes[0]).toBe(alteredInodes[1]);
    expect(alteredInodes[0]).not.toBe(credentialBefore.ino);
    expect(Number.isSafeInteger(alteredInodes[0])).toBe(true);
    expect(realpathSync(credentialDir)).toBe(credentialDir);
    expect({
      dev: credentialAfter.dev,
      ino: credentialAfter.ino,
      mode: credentialAfter.mode,
      uid: credentialAfter.uid,
      nlink: credentialAfter.nlink,
    }).toEqual({
      dev: credentialBefore.dev,
      ino: credentialBefore.ino,
      mode: credentialBefore.mode,
      uid: credentialBefore.uid,
      nlink: credentialBefore.nlink,
    });
    expect(credentialAfter.isDirectory()).toBe(true);
    expect(credentialAfter.isSymbolicLink()).toBe(false);
    expect(pidBefore).not.toBeNull();
    expect(tokenBefore).not.toBeNull();
    expect(recordBefore).toBeNull();
    expect(quarantineBefore).toBeNull();
    expect(recordAtBoundary).not.toBeNull();
    expect(recordAtBoundary?.mode ?? 0).toSatisfy((mode: number) => (mode & 0o077) === 0);
    expect(recordAfter).toEqual(recordAtBoundary);
    expect(quarantineAtBoundary).toBeNull();
    expect(quarantineAfter).toEqual(quarantineAtBoundary);
    expect(pidAtBoundary).toBeNull();
    expect(pidAfter).toEqual(pidAtBoundary);
    expect(tokenAtBoundary).toEqual(tokenBefore);
    expect(tokenAfter).toEqual(tokenAtBoundary);
    expect(signalCallsAtBoundary).toBeGreaterThan(0);
    expect(fixture.killProcess).toHaveBeenCalledTimes(signalCallsAtBoundary ?? -1);
    expect(ensureCallsAtBoundary).toBe(0);
    expect(fixture.ensureReplacement).toHaveBeenCalledTimes(ensureCallsAtBoundary ?? -1);
    expect(spawnCallsAtBoundary).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(spawnCallsAtBoundary ?? -1);
    expect(tokenReadsAtBoundary).toBe(0);
    expect(tokenReadsAfter).toBe(tokenReadsAtBoundary);
    expect(lifecycleMutation).toHaveBeenCalledTimes(mutationCallsAtBoundary ?? -1);
    expect(boundaries).not.toContain("after-replacement-readiness");
    expect(boundaries).not.toContain("before-record-proof");
    expect(boundaries).not.toContain("before-record-cleanup");
    expect(boundaries).not.toContain("before-terminal-restart-publication");
    expect(lifecycleMutation).not.toHaveBeenCalledWith("finalize");
  });

  it("authenticates and publishes an authorized replacement through hermetic systemd", async () => {
    const fixture = createCapturedReaderFixture();
    const hermeticSeams = fixture.options._hermeticTestSeams;
    if (hermeticSeams === undefined) throw new Error("captured hermetic seams are unavailable");
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    const systemdRun = vi.fn((command: string): Readonly<{
      status: number;
      stdout: string;
      stderr: string;
    }> => {
      expect(command).toBe("systemd-run");
      void fixture.ensureReplacement();
      return { status: 0, stdout: "", stderr: "" };
    });
    let tokenReadsAfter = 0;
    fs.tokenReadTarget = fixture.tokenFile;

    try {
      const result = await restartDaemonProduction({
        ...fixture.options,
        enforceUserManagerParent: true,
        spawnTimeoutMs: 1_000,
        _ensureDaemonOverride: undefined,
        _hermeticTestSeams: {
          ...hermeticSeams,
          spawnSync: systemdRun as never,
        },
      });
      tokenReadsAfter = fs.tokenContentReadCalls;

      expect(result).toEqual({
        connected: true,
        port: 19999,
        spawned: true,
        pid: 5252,
        parentPid: 3131,
        userSystemdPid: 3131,
        restartedForParent: false,
        startMethod: "systemd-user",
        restarted: true,
        stoppedPid: 4242,
      });
      expect(systemdRun).toHaveBeenCalledOnce();
      expect(fixture.ensureReplacement).toHaveBeenCalledOnce();
      expect(fixture.killProcess).toHaveBeenCalledWith(4242, "SIGTERM");
      expect(readFileSync(fixture.pidFile, "utf8")).toBe("5252");
      expect(lstatSync(recordPath, { throwIfNoEntry: false })).toBeUndefined();
      expect(lstatSync(quarantinePath, { throwIfNoEntry: false })).toBeUndefined();
      expect(readWithoutTokenAccounting(
        () => readFileSync(fixture.tokenFile, "utf8"),
      )).toBe("local-token");
    } finally {
      fs.tokenReadTarget = null;
      fs.tokenContentReadCalls = 0;
    }

    expect(tokenReadsAfter).toBeGreaterThan(0);
    expect(fs.descriptorPaths.size).toBe(0);
    expect(fs.descriptorFstatCalls.size).toBe(0);
    expect(fs.descriptorReadCalls.size).toBe(0);
  });

  it("rejects an authorized candidate whose evidence changes after token read", async () => {
    const fixture = createCapturedReaderFixture();
    const hermeticSeams = fixture.options._hermeticTestSeams;
    if (hermeticSeams === undefined) throw new Error("captured hermetic seams are unavailable");
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    const replacementStatPath = join(fixture.procRoot, "5252", "stat");
    let deadlineExpired = false;
    let tokenMutationCalls = 0;
    let tokenReadsAfter = 0;
    const systemdRun = vi.fn((): Readonly<{
      status: number;
      stdout: string;
      stderr: string;
    }> => {
      void fixture.ensureReplacement();
      return { status: 0, stdout: "", stderr: "" };
    });
    fs.tokenReadTarget = fixture.tokenFile;
    fs.tokenContentReadObservation = (path: string): void => {
      expect(path).toBe(fixture.tokenFile);
      if (tokenMutationCalls > 0) return;
      tokenMutationCalls += 1;
      writeFileSync(replacementStatPath, terminalChangedStartTime(replacementStatPath));
      deadlineExpired = true;
    };

    try {
      const result = await restartDaemonProduction({
        ...fixture.options,
        enforceUserManagerParent: true,
        spawnTimeoutMs: 100,
        _ensureDaemonOverride: undefined,
        _monotonicNowOverride: (): number => deadlineExpired ? 1_000 : 0,
        _hermeticTestSeams: {
          ...hermeticSeams,
          spawnSync: systemdRun as never,
        },
      });
      tokenReadsAfter = fs.tokenContentReadCalls;

      expect(result).toMatchObject({
        connected: false,
        port: 19999,
        spawned: true,
        stoppedPid: 4242,
        restarted: false,
        warning: expect.stringContaining(
          "offline restart stopped PID 4242, but replacement readiness failed",
        ),
      });
      expect(systemdRun).toHaveBeenCalledOnce();
      expect(fixture.ensureReplacement).toHaveBeenCalledOnce();
      expect(fixture.killProcess).toHaveBeenCalledWith(4242, "SIGTERM");
      expect(readFileSync(fixture.pidFile, "utf8")).toBe("5252");
      expect(lstatSync(quarantinePath, { throwIfNoEntry: false })).toBeUndefined();
      expect(readFileSync(recordPath, "utf8")).toContain('"kind":"lcm-offline-restart"');
      expect(readWithoutTokenAccounting(
        () => readFileSync(fixture.tokenFile, "utf8"),
      )).toBe("local-token");
    } finally {
      fs.tokenContentReadObservation = null;
      fs.tokenReadTarget = null;
      fs.tokenContentReadCalls = 0;
    }

    expect(tokenMutationCalls).toBe(1);
    expect(tokenReadsAfter).toBeGreaterThan(0);
    expect(fs.descriptorPaths.size).toBe(0);
    expect(fs.descriptorFstatCalls.size).toBe(0);
    expect(fs.descriptorReadCalls.size).toBe(0);
  });

  it.each([
    ["exact early EOF", "cmdline", "early-eof"],
    ["dynamic early EOF", "stat", "early-eof"],
    ["exact read failure", "cmdline", "read-throw"],
    ["dynamic read failure", "stat", "read-throw"],
    ["exact second-fstat drift", "cmdline", "second-fstat-drift"],
    ["dynamic second-fstat drift", "stat", "second-fstat-drift"],
    ["exact close failure", "cmdline", "close-failure"],
    ["dynamic close failure", "stat", "close-failure"],
  ] as const)(
    "refuses terminal publication after captured-native %s",
    async (
      _label: string,
      leaf: "cmdline" | "stat",
      fault: "early-eof" | "read-throw" | "second-fstat-drift" | "close-failure",
    ): Promise<void> => {
      const fixture = createCapturedReaderFixture();
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
      let exactRecoveryBytes = "";
      let signalCallsBefore = 0;
      const result = await restartDaemonProduction({
        ...fixture.options,
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          if (phase === "before-record-cleanup") {
            exactRecoveryBytes = readFileSync(recordPath, "utf8");
          }
          if (phase !== "before-terminal-restart-publication") return;
          fs.terminalTarget = join(fixture.procRoot, "5252", leaf);
          fs.terminalFault = fault;
          signalCallsBefore = fixture.killProcess.mock.calls.length;
        },
      });

      expect(result).toMatchObject({
        connected: false,
        restarted: false,
        warning: expect.stringContaining("terminal callback-free replacement"),
      });
      expect(fixture.killProcess).toHaveBeenCalledTimes(signalCallsBefore);
      expect(fixture.ensureReplacement).toHaveBeenCalledOnce();
      expect(readFileSync(fixture.pidFile, "utf8")).toBe("5252");
      expect(readFileSync(fixture.tokenFile, "utf8")).toBe("local-token");
      expect(readFileSync(quarantinePath, "utf8")).toBe(exactRecoveryBytes);
    },
  );

  type HeldUnlinkNativeFaultCase = Readonly<{
    label: string;
    faults: readonly HeldUnlinkNativeFault[];
    authority: "record" | "backup";
  }>;

  const heldUnlinkNativeFaultCases: readonly HeldUnlinkNativeFaultCase[] = [
    { label: "held parent proof mismatch", faults: ["parent-proof"], authority: "record" },
    { label: "procfd parent mismatch", faults: ["parent-realpath"], authority: "record" },
    { label: "anchored target open failure", faults: ["target-open"], authority: "record" },
    { label: "held target proof mismatch", faults: ["target-proof"], authority: "record" },
    { label: "anchored unlink failure", faults: ["unlink"], authority: "record" },
    {
      label: "target-open and held-parent close failures",
      faults: ["target-open", "parent-close"],
      authority: "record",
    },
    {
      label: "post-unlink held target mismatch",
      faults: ["target-post-proof"],
      authority: "backup",
    },
    {
      label: "post-unlink held target fstat failure",
      faults: ["target-post-proof-throw"],
      authority: "backup",
    },
    {
      label: "post-unlink target and close mismatch",
      faults: ["target-post-proof", "target-close"],
      authority: "backup",
    },
    {
      label: "anchored post-unlink lstat failure",
      faults: ["anchored-lstat-error"],
      authority: "backup",
    },
    { label: "held parent fsync failure", faults: ["parent-fsync"], authority: "backup" },
    {
      label: "held parent post-fsync proof mismatch",
      faults: ["parent-post-proof"],
      authority: "backup",
    },
    {
      label: "held parent post-fsync procfd mismatch",
      faults: ["parent-post-realpath"],
      authority: "backup",
    },
    { label: "canonical parent open failure", faults: ["canonical-open"], authority: "backup" },
    { label: "canonical parent proof mismatch", faults: ["canonical-proof"], authority: "backup" },
    { label: "canonical parent close failure", faults: ["canonical-close"], authority: "backup" },
  ];

  it.each(heldUnlinkNativeFaultCases)(
    "fails closed after captured-native $label",
    async (testCase): Promise<void> => {
      const fixture = createCapturedReaderFixture();
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
      let exactRecoveryBytes = "";
      let faultCalls: ReadonlyMap<HeldUnlinkNativeFault, number> = new Map();
      let tokenReadsAtBoundary: number | undefined;
      let tokenReadsAtHeldNative: number | null = null;
      let tokenReadsAfter = 0;
      fs.tokenReadTarget = fixture.tokenFile;

      try {
        const result = await restartDaemonProduction({
          ...fixture.options,
          _offlineRecoveryBoundaryOverride: (phase: string): void => {
            if (phase === "before-record-cleanup") {
              exactRecoveryBytes = readFileSync(recordPath, "utf8");
              tokenReadsAtBoundary = fs.tokenContentReadCalls;
              fs.heldUnlinkTarget = recordPath;
              for (const fault of testCase.faults) fs.heldUnlinkFaults.add(fault);
            }
          },
        });

        faultCalls = new Map(fs.heldUnlinkFaultCalls);
        expect(result).toMatchObject({
          connected: false,
          restarted: false,
          pid: 5252,
          stoppedPid: 4242,
          warning: expect.stringContaining("offline restart replacement is not publishable"),
        });
        expect(result.warning).toContain(
          testCase.authority === "record" ? recordPath : quarantinePath,
        );
        expect(fixture.ensureReplacement).toHaveBeenCalledOnce();
        expect(readWithoutTokenAccounting(
          () => readFileSync(fixture.tokenFile, "utf8"),
        )).toBe("local-token");
        expect(readFileSync(quarantinePath, "utf8")).toBe(exactRecoveryBytes);
        if (testCase.authority === "record") {
          expect(readFileSync(recordPath, "utf8")).toBe(exactRecoveryBytes);
        } else {
          expect(lstatSync(recordPath, { throwIfNoEntry: false })).toBeUndefined();
        }
      } finally {
        tokenReadsAtHeldNative = fs.heldUnlinkNativeStartTokenReads;
        tokenReadsAfter = fs.tokenContentReadCalls;
        fs.heldUnlinkTarget = null;
        fs.heldUnlinkFaults.clear();
        fs.heldUnlinkFaultCalls.clear();
        fs.heldUnlinkParentDescriptor = null;
        fs.heldUnlinkNativeStartTokenReads = null;
        fs.heldUnlinkTargetDescriptor = null;
        fs.heldUnlinkCanonicalDescriptor = null;
        fs.heldUnlinkParentFstatCalls = 0;
        fs.heldUnlinkTargetFstatCalls = 0;
        fs.heldUnlinkCanonicalFstatCalls = 0;
        fs.heldUnlinkParentRealpathCalls = 0;
        fs.heldUnlinkObserved = false;
        fs.tokenReadTarget = null;
        fs.tokenContentReadCalls = 0;
      }

      expect(exactRecoveryBytes).not.toBe("");
      expect(tokenReadsAtBoundary).toBeDefined();
      expect(tokenReadsAtHeldNative).toBe((tokenReadsAtBoundary ?? -2) + 2);
      expect(tokenReadsAfter).toBe(tokenReadsAtHeldNative);
      expect([...faultCalls.keys()].sort()).toEqual([...testCase.faults].sort());
      expect([...faultCalls.values()]).toEqual(
        Array.from({ length: testCase.faults.length }, () => 1),
      );
      expect(fs.descriptorPaths.size).toBe(0);
      expect(fs.descriptorFstatCalls.size).toBe(0);
      expect(fs.descriptorReadCalls.size).toBe(0);
    },
  );

  it("refuses a recovery backup changed by its pre-signal cleanup seam", async () => {
    const fixture = createCapturedReaderFixture();
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    let backupBytes = "";
    let backupUnlinkCalls = 0;
    let tokenReadsAfter = 0;
    fs.tokenReadTarget = fixture.tokenFile;

    try {
      await expect(restartDaemonProduction({
        ...fixture.options,
        _offlineRecoveryBackupUnlinkOverride: (path: string): void => {
          backupUnlinkCalls += 1;
          expect(path).toBe(quarantinePath);
          backupBytes = readFileSync(path, "utf8");
          writeFileSync(path, `${backupBytes} `);
        },
      })).rejects.toThrow(
        "Offline restart recovery refused for PID 4242: offline restart recovery backup cleanup was not durable.",
      );
      tokenReadsAfter = fs.tokenContentReadCalls;
    } finally {
      fs.tokenReadTarget = null;
      fs.tokenContentReadCalls = 0;
    }

    expect(backupBytes).not.toBe("");
    expect(backupUnlinkCalls).toBe(1);
    expect(tokenReadsAfter).toBe(0);
    expect(fixture.killProcess).not.toHaveBeenCalled();
    expect(fixture.ensureReplacement).not.toHaveBeenCalled();
    expect(readFileSync(recordPath, "utf8")).toBe(backupBytes);
    expect(readFileSync(quarantinePath, "utf8")).toBe(`${backupBytes} `);
    expect(readFileSync(fixture.pidFile, "utf8")).toBe("4242");
    expect(readWithoutTokenAccounting(
      () => readFileSync(fixture.tokenFile, "utf8"),
    )).toBe("local-token");
    expect(fs.descriptorPaths.size).toBe(0);
    expect(fs.descriptorFstatCalls.size).toBe(0);
    expect(fs.descriptorReadCalls.size).toBe(0);
  });

  it("retains a terminally provable backup after uncertain final unlink durability", async () => {
    const fixture = createCapturedReaderFixture();
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    let exactRecoveryBytes = "";
    let faultCalls = 0;
    let tokenReadsAtBoundary: number | undefined;
    let tokenReadsAtHeldNative: number | null = null;
    let tokenReadsAfter = 0;
    fs.tokenReadTarget = fixture.tokenFile;

    try {
      const result = await restartDaemonProduction({
        ...fixture.options,
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          if (phase === "before-record-cleanup") {
            exactRecoveryBytes = readFileSync(recordPath, "utf8");
          }
          if (phase === "before-final-backup-cleanup") {
            tokenReadsAtBoundary = fs.tokenContentReadCalls;
            fs.heldUnlinkTarget = quarantinePath;
            fs.heldUnlinkFaults.add("parent-fsync");
          }
        },
      });

      faultCalls = fs.heldUnlinkFaultCalls.get("parent-fsync") ?? 0;
      expect(result).toMatchObject({
        connected: true,
        restarted: true,
        pid: 5252,
        stoppedPid: 4242,
        warning: expect.stringContaining("final cleanup durability was uncertain"),
      });
      expect(lstatSync(recordPath, { throwIfNoEntry: false })).toBeUndefined();
      expect(readFileSync(quarantinePath, "utf8")).toBe(exactRecoveryBytes);
      expect(readWithoutTokenAccounting(
        () => readFileSync(fixture.tokenFile, "utf8"),
      )).toBe("local-token");
    } finally {
      tokenReadsAtHeldNative = fs.heldUnlinkNativeStartTokenReads;
      tokenReadsAfter = fs.tokenContentReadCalls;
      fs.heldUnlinkTarget = null;
      fs.heldUnlinkFaults.clear();
      fs.heldUnlinkFaultCalls.clear();
      fs.heldUnlinkParentDescriptor = null;
      fs.heldUnlinkNativeStartTokenReads = null;
      fs.heldUnlinkTargetDescriptor = null;
      fs.heldUnlinkCanonicalDescriptor = null;
      fs.heldUnlinkParentFstatCalls = 0;
      fs.heldUnlinkTargetFstatCalls = 0;
      fs.heldUnlinkCanonicalFstatCalls = 0;
      fs.heldUnlinkParentRealpathCalls = 0;
      fs.heldUnlinkObserved = false;
      fs.tokenReadTarget = null;
      fs.tokenContentReadCalls = 0;
    }

    expect(exactRecoveryBytes).not.toBe("");
    expect(tokenReadsAtBoundary).toBeDefined();
    expect(tokenReadsAtHeldNative).toBe((tokenReadsAtBoundary ?? -2) + 2);
    expect(tokenReadsAfter).toBe(tokenReadsAtHeldNative);
    expect(faultCalls).toBe(1);
    expect(fs.descriptorPaths.size).toBe(0);
    expect(fs.descriptorFstatCalls.size).toBe(0);
    expect(fs.descriptorReadCalls.size).toBe(0);
  });

  it("restores an exact warning backup after its terminal proof drifts", async () => {
    const fixture = createCapturedReaderFixture();
    const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
    const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
    let exactRecoveryBytes = "";
    let signalCallsBefore = 0;
    let ensureCallsBefore = 0;
    let tokenReadsBefore = 0;
    let heldFaultCalls = 0;
    let fstatFaultCalls = 0;
    fs.tokenReadTarget = fixture.tokenFile;

    try {
      const result = await restartDaemonProduction({
        ...fixture.options,
        _offlineRecoveryBoundaryOverride: (phase: string): void => {
          if (phase === "before-record-cleanup") {
            exactRecoveryBytes = readFileSync(recordPath, "utf8");
          }
          if (phase === "before-final-backup-cleanup") {
            fs.heldUnlinkTarget = quarantinePath;
            fs.heldUnlinkFaults.add("parent-fsync");
          }
          if (phase !== "before-terminal-restart-publication") return;
          signalCallsBefore = fixture.killProcess.mock.calls.length;
          ensureCallsBefore = fixture.ensureReplacement.mock.calls.length;
          tokenReadsBefore = fs.tokenContentReadCalls;
          fs.capturedFstatFaultTarget = quarantinePath;
          fs.capturedFstatFaultOrdinal = 1;
          fs.capturedFstatFaultKind = "second-drift";
          fs.capturedFstatFaultArmed = true;
        },
      });

      heldFaultCalls = fs.heldUnlinkFaultCalls.get("parent-fsync") ?? 0;
      fstatFaultCalls = fs.capturedFstatFaultCount;
      expect(result).toMatchObject({
        connected: false,
        restarted: false,
        pid: 5252,
        stoppedPid: 4242,
        warning: expect.stringContaining(
          "terminal callback-free replacement and recovery-authority proof failed",
        ),
      });
      expect(result.warning).toContain("exact durable recovery backup was restored or preserved");
      expect(fixture.killProcess).toHaveBeenCalledTimes(signalCallsBefore);
      expect(fixture.ensureReplacement).toHaveBeenCalledTimes(ensureCallsBefore);
      expect(fs.tokenContentReadCalls).toBe(tokenReadsBefore);
      expect(lstatSync(recordPath, { throwIfNoEntry: false })).toBeUndefined();
      expect(readFileSync(quarantinePath, "utf8")).toBe(exactRecoveryBytes);
      expect(readWithoutTokenAccounting(
        () => readFileSync(fixture.tokenFile, "utf8"),
      )).toBe("local-token");
    } finally {
      fs.heldUnlinkTarget = null;
      fs.heldUnlinkFaults.clear();
      fs.heldUnlinkFaultCalls.clear();
      fs.heldUnlinkParentDescriptor = null;
      fs.heldUnlinkNativeStartTokenReads = null;
      fs.heldUnlinkTargetDescriptor = null;
      fs.heldUnlinkCanonicalDescriptor = null;
      fs.heldUnlinkParentFstatCalls = 0;
      fs.heldUnlinkTargetFstatCalls = 0;
      fs.heldUnlinkCanonicalFstatCalls = 0;
      fs.heldUnlinkParentRealpathCalls = 0;
      fs.heldUnlinkObserved = false;
      fs.capturedFstatFaultTarget = null;
      fs.capturedFstatFaultDescriptor = null;
      fs.capturedFstatFaultArmed = false;
      fs.capturedFstatFaultConsumed = false;
      fs.capturedFstatFaultCount = 0;
      fs.capturedFstatFaultIno = null;
      fs.capturedFstatFaultOrdinal = 1;
      fs.capturedFstatFaultMatchCount = 0;
      fs.capturedFstatFaultKind = "inode";
      fs.tokenReadTarget = null;
      fs.tokenContentReadCalls = 0;
    }

    expect(exactRecoveryBytes).not.toBe("");
    expect(heldFaultCalls).toBe(1);
    expect(fstatFaultCalls).toBe(2);
    expect(fs.descriptorPaths.size).toBe(0);
    expect(fs.descriptorFstatCalls.size).toBe(0);
    expect(fs.descriptorReadCalls.size).toBe(0);
  });

  type TerminalNativeFaultCase = Readonly<{
    label: string;
    mechanism: "captured-fstat" | "captured-open" | "path" | "terminal";
    target: "fd" | "fd-entry" | "original-directory" | "proc-root"
      | "replacement-directory" | "state" | "token";
    fault: "close-failure" | "fsync-throw" | "inode" | "lstat-throw"
      | "readlink-mismatch" | "readlink-throw" | "readdir-empty"
      | "readdir-invalid" | "readdir-throw" | "second-fstat-drift";
  }>;

  const terminalNativeFaultCases: readonly TerminalNativeFaultCase[] = [
    {
      label: "stable metadata open failure",
      mechanism: "captured-open",
      target: "token",
      fault: "lstat-throw",
    },
    {
      label: "stable metadata close failure",
      mechanism: "terminal",
      target: "token",
      fault: "close-failure",
    },
    {
      label: "direct directory close failure",
      mechanism: "terminal",
      target: "proc-root",
      fault: "close-failure",
    },
    {
      label: "replacement directory close failure",
      mechanism: "terminal",
      target: "replacement-directory",
      fault: "close-failure",
    },
    {
      label: "clean-state directory fsync failure",
      mechanism: "path",
      target: "state",
      fault: "fsync-throw",
    },
    {
      label: "missing original-directory lstat failure",
      mechanism: "path",
      target: "original-directory",
      fault: "lstat-throw",
    },
    {
      label: "listener fd proof mismatch",
      mechanism: "captured-fstat",
      target: "fd",
      fault: "inode",
    },
    {
      label: "listener fd drift",
      mechanism: "terminal",
      target: "fd",
      fault: "second-fstat-drift",
    },
    {
      label: "listener fd close failure",
      mechanism: "terminal",
      target: "fd",
      fault: "close-failure",
    },
    {
      label: "listener fd readdir failure",
      mechanism: "path",
      target: "fd",
      fault: "readdir-throw",
    },
    {
      label: "listener empty fd entry",
      mechanism: "path",
      target: "fd",
      fault: "readdir-empty",
    },
    {
      label: "listener invalid fd entry",
      mechanism: "path",
      target: "fd",
      fault: "readdir-invalid",
    },
    {
      label: "listener readlink failure",
      mechanism: "path",
      target: "fd-entry",
      fault: "readlink-throw",
    },
    {
      label: "listener readlink mismatch",
      mechanism: "path",
      target: "fd-entry",
      fault: "readlink-mismatch",
    },
  ];

  it.each(terminalNativeFaultCases)(
    "refuses terminal publication after captured-native $label",
    async (testCase): Promise<void> => {
      const fixture = createCapturedReaderFixture();
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
      const fdPath = join(fixture.procRoot, "5252", "fd");
      let exactRecoveryBytes = "";
      let faultTarget = "";
      let signalCallsBefore = 0;
      let ensureCallsBefore = 0;
      let tokenReadsBefore = 0;
      let terminalFaultCalls = 0;
      let terminalFaultConsumed = false;
      fs.tokenReadTarget = fixture.tokenFile;

      try {
        const result = await restartDaemonProduction({
          ...fixture.options,
          spawnTimeoutMs: 1_000,
          _offlineRecoveryBoundaryOverride: (phase: string): void => {
            if (phase === "before-record-cleanup") {
              exactRecoveryBytes = readFileSync(recordPath, "utf8");
            }
            if (phase !== "before-terminal-restart-publication") return;
            signalCallsBefore = fixture.killProcess.mock.calls.length;
            ensureCallsBefore = fixture.ensureReplacement.mock.calls.length;
            tokenReadsBefore = fs.tokenContentReadCalls;
            if (testCase.target === "fd") faultTarget = fdPath;
            else if (testCase.target === "fd-entry") faultTarget = join(fdPath, "7");
            else if (testCase.target === "original-directory") {
              faultTarget = join(fixture.procRoot, "4242");
            } else if (testCase.target === "proc-root") faultTarget = fixture.procRoot;
            else if (testCase.target === "replacement-directory") {
              faultTarget = join(fixture.procRoot, "5252");
            }
            else if (testCase.target === "state") faultTarget = fixture.root;
            else faultTarget = fixture.tokenFile;

            if (testCase.mechanism === "captured-open") {
              fs.capturedOpenFaultTarget = faultTarget;
              fs.capturedOpenFaultOrdinal = 1;
              fs.capturedOpenFaultArmed = true;
            } else if (testCase.mechanism === "captured-fstat") {
              fs.capturedFstatFaultTarget = faultTarget;
              fs.capturedFstatFaultOrdinal = 1;
              fs.capturedFstatFaultKind = "inode";
              fs.capturedFstatFaultArmed = true;
            } else if (testCase.mechanism === "terminal") {
              fs.terminalTarget = faultTarget;
              fs.terminalFaultOrdinal = 1;
              fs.terminalFault = testCase.fault;
            } else {
              fs.terminalPathFaultTarget = faultTarget;
              fs.terminalPathFault = testCase.fault;
            }
          },
        });

        terminalFaultCalls = fs.terminalPathFaultCalls
          + fs.capturedOpenFaultMatchCount
          + fs.capturedFstatFaultCount
          + fs.terminalFaultMatchCount;
        terminalFaultConsumed = fs.capturedOpenFaultConsumed
          || fs.capturedFstatFaultConsumed
          || fs.terminalFaultConsumed
          || fs.terminalPathFaultCalls > 0;
        expect(result).toMatchObject({
          connected: false,
          restarted: false,
          pid: 5252,
          stoppedPid: 4242,
          warning: expect.stringContaining("terminal callback-free replacement"),
        });
        expect(fixture.killProcess).toHaveBeenCalledTimes(signalCallsBefore);
        expect(fixture.ensureReplacement).toHaveBeenCalledTimes(ensureCallsBefore);
        expect(fs.tokenContentReadCalls).toBe(tokenReadsBefore);
        expect(readFileSync(fixture.pidFile, "utf8")).toBe("5252");
        expect(readFileSync(fixture.tokenFile, "utf8")).toBe("local-token");
        expect(readFileSync(quarantinePath, "utf8")).toBe(exactRecoveryBytes);
      } finally {
        fs.terminalFault = null;
        fs.terminalTarget = null;
        fs.terminalFaultDescriptor = null;
        fs.terminalFaultConsumed = false;
        fs.terminalFaultOrdinal = 1;
        fs.terminalFaultMatchCount = 0;
        fs.terminalFaultDescriptors.clear();
        fs.terminalPathFault = null;
        fs.terminalPathFaultTarget = null;
        fs.terminalPathFaultCalls = 0;
        fs.capturedOpenFaultTarget = null;
        fs.capturedOpenFaultArmed = false;
        fs.capturedOpenFaultConsumed = false;
        fs.capturedOpenFaultOrdinal = 1;
        fs.capturedOpenFaultMatchCount = 0;
        fs.capturedOpenFaultDescriptors.clear();
        fs.capturedFstatFaultTarget = null;
        fs.capturedFstatFaultDescriptor = null;
        fs.capturedFstatFaultArmed = false;
        fs.capturedFstatFaultConsumed = false;
        fs.capturedFstatFaultCount = 0;
        fs.capturedFstatFaultIno = null;
        fs.capturedFstatFaultOrdinal = 1;
        fs.capturedFstatFaultMatchCount = 0;
        fs.capturedFstatFaultKind = "inode";
        fs.tokenReadTarget = null;
        fs.tokenContentReadCalls = 0;
      }

      expect(faultTarget).not.toBe("");
      expect(terminalFaultCalls).toBeGreaterThan(0);
      expect(terminalFaultConsumed).toBe(true);
      expect(exactRecoveryBytes).not.toBe("");
      expect(fs.descriptorPaths.size).toBe(0);
      expect(fs.descriptorFstatCalls.size).toBe(0);
      expect(fs.descriptorReadCalls.size).toBe(0);
    },
  );

  type TerminalDurabilityFaultCase =
    | Readonly<{
      label: string;
      mechanism: "captured-fstat";
      target: "quarantine" | "state";
      ordinal: number;
      fault: "inode" | "mode" | "second-drift";
      corruptProof: boolean;
      quarantine: "absent" | "empty" | "present";
    }>
    | Readonly<{
      label: string;
      mechanism: "captured-open";
      target: "quarantine" | "state";
      ordinal: number;
      fault: "open";
      corruptProof: boolean;
      quarantine: "absent" | "present";
    }>
    | Readonly<{
      label: string;
      mechanism: "path";
      target: "quarantine";
      ordinal: number;
      fault: "fchmod-throw" | "fsync-throw" | "write-throw" | "write-zero";
      corruptProof: true;
      quarantine: "absent" | "empty" | "present";
    }>
    | Readonly<{
      label: string;
      mechanism: "terminal";
      target: "quarantine" | "state";
      ordinal: number;
      fault: "close-failure";
      corruptProof: boolean;
      quarantine: "present";
    }>;

  const terminalDurabilityFaultCases: readonly TerminalDurabilityFaultCase[] = [
    {
      label: "clean-state directory proof mismatch before fsync",
      mechanism: "captured-fstat",
      target: "state",
      ordinal: 4,
      fault: "inode",
      corruptProof: false,
      quarantine: "present",
    },
    {
      label: "clean-state directory close failure after fsync",
      mechanism: "terminal",
      target: "state",
      ordinal: 4,
      fault: "close-failure",
      corruptProof: false,
      quarantine: "present",
    },
    {
      label: "clean-state directory open failure before fsync",
      mechanism: "captured-open",
      target: "state",
      ordinal: 4,
      fault: "open",
      corruptProof: false,
      quarantine: "present",
    },
    {
      label: "backup file proof mismatch before fsync",
      mechanism: "captured-fstat",
      target: "quarantine",
      ordinal: 3,
      fault: "inode",
      corruptProof: true,
      quarantine: "present",
    },
    {
      label: "backup file open failure before fsync",
      mechanism: "captured-open",
      target: "quarantine",
      ordinal: 4,
      fault: "open",
      corruptProof: true,
      quarantine: "present",
    },
    {
      label: "backup file fsync failure",
      mechanism: "path",
      target: "quarantine",
      ordinal: 2,
      fault: "fsync-throw",
      corruptProof: true,
      quarantine: "present",
    },
    {
      label: "backup file close failure after fsync",
      mechanism: "terminal",
      target: "quarantine",
      ordinal: 3,
      fault: "close-failure",
      corruptProof: true,
      quarantine: "present",
    },
    {
      label: "backup create open failure",
      mechanism: "captured-open",
      target: "quarantine",
      ordinal: 2,
      fault: "open",
      corruptProof: true,
      quarantine: "absent",
    },
    {
      label: "backup chmod failure",
      mechanism: "path",
      target: "quarantine",
      ordinal: 1,
      fault: "fchmod-throw",
      corruptProof: true,
      quarantine: "empty",
    },
    {
      label: "backup write failure",
      mechanism: "path",
      target: "quarantine",
      ordinal: 1,
      fault: "write-throw",
      corruptProof: true,
      quarantine: "empty",
    },
    {
      label: "backup zero-byte write",
      mechanism: "path",
      target: "quarantine",
      ordinal: 1,
      fault: "write-zero",
      corruptProof: true,
      quarantine: "empty",
    },
    {
      label: "backup metadata mismatch",
      mechanism: "captured-fstat",
      target: "quarantine",
      ordinal: 1,
      fault: "mode",
      corruptProof: true,
      quarantine: "present",
    },
    {
      label: "backup metadata drift",
      mechanism: "captured-fstat",
      target: "quarantine",
      ordinal: 1,
      fault: "second-drift",
      corruptProof: true,
      quarantine: "present",
    },
    {
      label: "backup create fsync failure",
      mechanism: "path",
      target: "quarantine",
      ordinal: 1,
      fault: "fsync-throw",
      corruptProof: true,
      quarantine: "present",
    },
    {
      label: "backup create close failure",
      mechanism: "terminal",
      target: "quarantine",
      ordinal: 1,
      fault: "close-failure",
      corruptProof: true,
      quarantine: "present",
    },
  ];

  it.each(terminalDurabilityFaultCases)(
    "fails closed after captured-native $label",
    async (testCase): Promise<void> => {
      const fixture = createCapturedReaderFixture();
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
      const replacementStatPath = join(fixture.procRoot, "5252", "stat");
      let exactRecoveryBytes = "";
      let signalCallsBefore = 0;
      let ensureCallsBefore = 0;
      let tokenReadsBefore = 0;
      let faultCalls = 0;
      let replacementCalls = 0;
      fs.tokenReadTarget = fixture.tokenFile;

      try {
        const result = await restartDaemonProduction({
          ...fixture.options,
          _offlineRecoveryBoundaryOverride: (phase: string): void => {
            if (phase === "before-record-cleanup") {
              exactRecoveryBytes = readFileSync(recordPath, "utf8");
            }
            if (phase !== "before-terminal-restart-publication") return;
            signalCallsBefore = fixture.killProcess.mock.calls.length;
            ensureCallsBefore = fixture.ensureReplacement.mock.calls.length;
            tokenReadsBefore = fs.tokenContentReadCalls;
            if (testCase.corruptProof) {
              fs.terminalReadReplacementTarget = replacementStatPath;
              fs.terminalReadReplacementBytes = terminalChangedStartTime(replacementStatPath);
            }
            const target = testCase.target === "state" ? fixture.root : quarantinePath;
            if (testCase.mechanism === "captured-fstat") {
              fs.capturedFstatFaultTarget = target;
              fs.capturedFstatFaultOrdinal = testCase.ordinal;
              fs.capturedFstatFaultKind = testCase.fault;
              fs.capturedFstatFaultArmed = true;
            } else if (testCase.mechanism === "captured-open") {
              fs.capturedOpenFaultTarget = target;
              fs.capturedOpenFaultOrdinal = testCase.ordinal;
              fs.capturedOpenFaultArmed = true;
            } else if (testCase.mechanism === "terminal") {
              fs.terminalTarget = target;
              fs.terminalFaultOrdinal = testCase.ordinal;
              fs.terminalFault = testCase.fault;
            } else {
              fs.terminalPathFaultTarget = target;
              fs.terminalPathFaultOrdinal = testCase.ordinal;
              fs.terminalPathFault = testCase.fault;
            }
          },
        });

        faultCalls = fs.terminalPathFaultCalls
          + fs.capturedOpenFaultMatchCount
          + fs.capturedFstatFaultCount
          + fs.terminalFaultMatchCount;
        replacementCalls = fs.terminalReadReplacementCalls;
        expect(result).toMatchObject({
          connected: false,
          restarted: false,
          pid: 5252,
          stoppedPid: 4242,
          warning: expect.stringContaining("terminal callback-free replacement"),
        });
        expect(fixture.killProcess).toHaveBeenCalledTimes(signalCallsBefore);
        expect(fixture.ensureReplacement).toHaveBeenCalledTimes(ensureCallsBefore);
        expect(fs.tokenContentReadCalls).toBe(tokenReadsBefore);
        expect(readFileSync(fixture.pidFile, "utf8")).toBe("5252");
        expect(readFileSync(fixture.tokenFile, "utf8")).toBe("local-token");
        if (testCase.quarantine === "present") {
          expect(readFileSync(quarantinePath, "utf8")).toBe(exactRecoveryBytes);
        } else if (testCase.quarantine === "absent") {
          expect(lstatSync(quarantinePath, { throwIfNoEntry: false })).toBeUndefined();
        } else {
          const quarantine = lstatSync(quarantinePath);
          expect(quarantine.isFile()).toBe(true);
          expect(quarantine.isSymbolicLink()).toBe(false);
          expect(quarantine.nlink).toBe(1);
          expect(quarantine.mode & 0o777).toBe(0o600);
          expect(readFileSync(quarantinePath)).toHaveLength(0);
        }
      } finally {
        fs.terminalFault = null;
        fs.terminalTarget = null;
        fs.terminalFaultDescriptor = null;
        fs.terminalFaultConsumed = false;
        fs.terminalFaultOrdinal = 1;
        fs.terminalFaultMatchCount = 0;
        fs.terminalFaultDescriptors.clear();
        fs.terminalReadReplacementTarget = null;
        fs.terminalReadReplacementBytes = null;
        fs.terminalReadReplacementCalls = 0;
        fs.terminalPathFault = null;
        fs.terminalPathFaultTarget = null;
        fs.terminalPathFaultOrdinal = 1;
        fs.terminalPathFaultCalls = 0;
        fs.capturedOpenFaultTarget = null;
        fs.capturedOpenFaultArmed = false;
        fs.capturedOpenFaultConsumed = false;
        fs.capturedOpenFaultOrdinal = 1;
        fs.capturedOpenFaultMatchCount = 0;
        fs.capturedOpenFaultDescriptors.clear();
        fs.capturedFstatFaultTarget = null;
        fs.capturedFstatFaultDescriptor = null;
        fs.capturedFstatFaultArmed = false;
        fs.capturedFstatFaultConsumed = false;
        fs.capturedFstatFaultCount = 0;
        fs.capturedFstatFaultIno = null;
        fs.capturedFstatFaultOrdinal = 1;
        fs.capturedFstatFaultMatchCount = 0;
        fs.capturedFstatFaultKind = "inode";
        fs.tokenReadTarget = null;
        fs.tokenContentReadCalls = 0;
      }

      expect(exactRecoveryBytes).not.toBe("");
      expect(faultCalls).toBeGreaterThan(0);
      expect(replacementCalls).toBe(testCase.corruptProof ? 1 : 0);
      expect(fs.descriptorPaths.size).toBe(0);
      expect(fs.descriptorFstatCalls.size).toBe(0);
      expect(fs.descriptorReadCalls.size).toBe(0);
    },
  );

  it.each([
    ["accepts an exact existing backup", "backup", false],
    ["refuses a drifting existing backup", "backup", true],
    ["accepts an exact existing record", "record", false],
  ] as const)(
    "restores authority when terminal recovery $label",
    async (
      _label: string,
      authority: "backup" | "record",
      drift: boolean,
    ): Promise<void> => {
      const fixture = createCapturedReaderFixture();
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
      let exactRecoveryBytes = "";
      let signalCallsBefore = 0;
      let ensureCallsBefore = 0;
      let tokenReadsBefore = 0;
      let fstatCalls = 0;
      fs.tokenReadTarget = fixture.tokenFile;

      try {
        const result = await restartDaemonProduction({
          ...fixture.options,
          _offlineRecoveryBoundaryOverride: (phase: string): void => {
            if (phase === "before-record-cleanup") {
              exactRecoveryBytes = readFileSync(recordPath, "utf8");
            }
            if (phase !== "before-terminal-restart-publication") return;
            signalCallsBefore = fixture.killProcess.mock.calls.length;
            ensureCallsBefore = fixture.ensureReplacement.mock.calls.length;
            tokenReadsBefore = fs.tokenContentReadCalls;
            const authorityPath = authority === "backup" ? quarantinePath : recordPath;
            writeFileSync(authorityPath, exactRecoveryBytes, { mode: 0o600 });
            chmodSync(authorityPath, 0o600);
            if (drift) {
              fs.capturedFstatFaultTarget = authorityPath;
              fs.capturedFstatFaultOrdinal = 1;
              fs.capturedFstatFaultKind = "second-drift";
              fs.capturedFstatFaultArmed = true;
            }
          },
        });

        fstatCalls = fs.capturedFstatFaultCount;
        expect(result).toMatchObject({
          connected: false,
          restarted: false,
          pid: 5252,
          stoppedPid: 4242,
          warning: expect.stringContaining("terminal callback-free replacement"),
        });
        if (drift) {
          expect(result.warning).toContain("authority or durability is indeterminate");
        } else if (authority === "record") {
          expect(result.warning).toContain("exact durable recovery authority remains");
        } else {
          expect(result.warning).toContain("exact durable recovery backup was restored or preserved");
        }
        expect(fixture.killProcess).toHaveBeenCalledTimes(signalCallsBefore);
        expect(fixture.ensureReplacement).toHaveBeenCalledTimes(ensureCallsBefore);
        expect(fs.tokenContentReadCalls).toBe(tokenReadsBefore);
        expect(readFileSync(fixture.pidFile, "utf8")).toBe("5252");
        expect(readFileSync(fixture.tokenFile, "utf8")).toBe("local-token");
        expect(readFileSync(
          authority === "backup" ? quarantinePath : recordPath,
          "utf8",
        )).toBe(exactRecoveryBytes);
      } finally {
        fs.capturedFstatFaultTarget = null;
        fs.capturedFstatFaultDescriptor = null;
        fs.capturedFstatFaultArmed = false;
        fs.capturedFstatFaultConsumed = false;
        fs.capturedFstatFaultCount = 0;
        fs.capturedFstatFaultIno = null;
        fs.capturedFstatFaultOrdinal = 1;
        fs.capturedFstatFaultMatchCount = 0;
        fs.capturedFstatFaultKind = "inode";
        fs.tokenReadTarget = null;
        fs.tokenContentReadCalls = 0;
      }

      expect(exactRecoveryBytes).not.toBe("");
      expect(fstatCalls).toBe(drift ? 2 : 0);
      expect(fs.descriptorPaths.size).toBe(0);
      expect(fs.descriptorFstatCalls.size).toBe(0);
      expect(fs.descriptorReadCalls.size).toBe(0);
    },
  );

  it.each([
    ["captured client-entrypoint realpath failure", "realpath"],
    ["client-entrypoint launch-path mismatch", "launch-path"],
  ] as const)(
    "refuses terminal seed publication after %s",
    async (_label: string, failure: "launch-path" | "realpath"): Promise<void> => {
      const fixture = createCapturedReaderFixture();
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
      const alternateEntrypoint = join(fixture.root, "alternate-lcm.mjs");
      let exactRecoveryBytes = "";
      let terminalBoundaryCalls = 0;
      let tokenReadsBeforeSeed = 0;
      let tokenReadsAfter = 0;
      let realpathFaultCalls = 0;
      let passiveOpenCalls = 0;
      fs.tokenReadTarget = fixture.tokenFile;

      try {
        const result = await restartDaemonProduction({
          ...fixture.options,
          _offlineRecoveryBoundaryOverride: (phase: string): void => {
            if (phase === "before-record-cleanup") {
              exactRecoveryBytes = readFileSync(recordPath, "utf8");
            }
            if (phase === "before-final-backup-cleanup") {
              fs.heldUnlinkTarget = quarantinePath;
              fs.heldUnlinkCompletionObservation = (): void => {
                tokenReadsBeforeSeed = fs.tokenContentReadCalls;
                fs.passiveOpenObservationTarget = join(fixture.procRoot, "5252", "cmdline");
                fs.passiveOpenObservationOrdinal = 2;
                fs.passiveOpenObservation = (): void => {
                  if (failure === "realpath") {
                    fs.terminalPathFaultTarget = fixture.entrypoint;
                    fs.terminalPathFault = "realpath-throw";
                  } else {
                    writeFileSync(alternateEntrypoint, "console.log('alternate runtime');\n");
                    process.argv[1] = alternateEntrypoint;
                  }
                };
              };
            }
            if (phase === "before-terminal-restart-publication") {
              terminalBoundaryCalls += 1;
            }
          },
        });

        tokenReadsAfter = fs.tokenContentReadCalls;
        realpathFaultCalls = fs.terminalPathFaultCalls;
        passiveOpenCalls = fs.passiveOpenObservationCount;
        expect(result).toMatchObject({
          connected: false,
          restarted: false,
          pid: 5252,
          stoppedPid: 4242,
          warning: expect.stringContaining(
            "terminal callback-free replacement and recovery-authority proof failed",
          ),
        });
        if (failure === "realpath") {
          expect(result.warning).toContain(
            "exact durable recovery backup was restored or preserved",
          );
          expect(readFileSync(quarantinePath, "utf8")).toBe(exactRecoveryBytes);
        } else {
          expect(result.warning).toContain("authority or durability is indeterminate");
        }
        expect(terminalBoundaryCalls).toBe(0);
        expect(fs.tokenContentReadCalls).toBe(tokenReadsBeforeSeed);
        expect(fixture.ensureReplacement).toHaveBeenCalledOnce();
        expect(readFileSync(fixture.pidFile, "utf8")).toBe("5252");
        expect(readWithoutTokenAccounting(
          () => readFileSync(fixture.tokenFile, "utf8"),
        )).toBe("local-token");
      } finally {
        fs.terminalPathFaultTarget = null;
        fs.terminalPathFault = null;
        fs.terminalPathFaultCalls = 0;
        fs.passiveOpenObservationTarget = null;
        fs.passiveOpenObservationOrdinal = 1;
        fs.passiveOpenObservationCount = 0;
        fs.passiveOpenObservation = null;
        fs.heldUnlinkTarget = null;
        fs.heldUnlinkCompletionObservation = null;
        fs.heldUnlinkParentDescriptor = null;
        fs.heldUnlinkTargetDescriptor = null;
        fs.heldUnlinkCanonicalDescriptor = null;
        fs.heldUnlinkParentFstatCalls = 0;
        fs.heldUnlinkTargetFstatCalls = 0;
        fs.heldUnlinkCanonicalFstatCalls = 0;
        fs.heldUnlinkParentRealpathCalls = 0;
        fs.heldUnlinkObserved = false;
        fs.tokenReadTarget = null;
        fs.tokenContentReadCalls = 0;
      }

      expect(exactRecoveryBytes).not.toBe("");
      expect(tokenReadsAfter).toBe(tokenReadsBeforeSeed);
      expect(passiveOpenCalls).toBe(2);
      if (failure === "realpath") expect(realpathFaultCalls).toBeGreaterThan(0);
      else expect(realpathFaultCalls).toBe(0);
      expect(fs.descriptorPaths.size).toBe(0);
      expect(fs.descriptorFstatCalls.size).toBe(0);
      expect(fs.descriptorReadCalls.size).toBe(0);
    },
  );

  it.each([
    { label: "returns a non-string digest", fault: "digest-nonstring" },
    { label: "throws while producing a digest", fault: "digest-throw" },
  ])(
    "refuses terminal publication when captured-native hashing $label",
    async ({ fault }): Promise<void> => {
      const fixture = createCapturedReaderFixture();
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
      let exactRecoveryBytes = "";
      let signalCallsBefore = 0;
      let ensureCallsBefore = 0;
      let tokenReadsBefore = 0;
      let hashCalls = 0;
      fs.tokenReadTarget = fixture.tokenFile;

      try {
        const result = await restartDaemonProduction({
          ...fixture.options,
          _offlineRecoveryBoundaryOverride: (phase: string): void => {
            if (phase === "before-record-cleanup") {
              exactRecoveryBytes = readFileSync(recordPath, "utf8");
            }
            if (phase !== "before-terminal-restart-publication") return;
            signalCallsBefore = fixture.killProcess.mock.calls.length;
            ensureCallsBefore = fixture.ensureReplacement.mock.calls.length;
            tokenReadsBefore = fs.tokenContentReadCalls;
            fs.terminalHashFault = fault;
          },
        });

        hashCalls = fs.terminalHashFaultCalls;
        expect(result).toMatchObject({
          connected: false,
          restarted: false,
          pid: 5252,
          stoppedPid: 4242,
          warning: expect.stringContaining("terminal callback-free replacement"),
        });
        expect(fixture.killProcess).toHaveBeenCalledTimes(signalCallsBefore);
        expect(fixture.ensureReplacement).toHaveBeenCalledTimes(ensureCallsBefore);
        expect(fs.tokenContentReadCalls).toBe(tokenReadsBefore);
        expect(readFileSync(fixture.pidFile, "utf8")).toBe("5252");
        expect(readFileSync(fixture.tokenFile, "utf8")).toBe("local-token");
        expect(readFileSync(quarantinePath, "utf8")).toBe(exactRecoveryBytes);
      } finally {
        fs.terminalHashFault = null;
        fs.terminalHashFaultCalls = 0;
        fs.tokenReadTarget = null;
        fs.tokenContentReadCalls = 0;
      }

      expect(exactRecoveryBytes).not.toBe("");
      expect(hashCalls).toBe(1);
      expect(fs.descriptorPaths.size).toBe(0);
      expect(fs.descriptorFstatCalls.size).toBe(0);
      expect(fs.descriptorReadCalls.size).toBe(0);
    },
  );

  type TerminalParserFaultCase = Readonly<{
    label: string;
    target: "stat" | "status" | "tcp";
    mutation: "empty" | "header-mismatch" | "hex-invalid" | "hex-lowercase"
      | "inode-mismatch" | "short-data" | "short-header" | "sl-mismatch"
      | "stat-missing-start" | "status-cr" | "status-short-line"
      | "status-token-mismatch" | "status-value-overrun" | "too-many-tokens"
      | "uid-mismatch" | "wildcard";
    succeeds: boolean;
  }>;

  const terminalParserFaultCases: readonly TerminalParserFaultCase[] = [
    {
      label: "a stat snapshot without the start-time field",
      target: "stat",
      mutation: "stat-missing-start",
      succeeds: false,
    },
    {
      label: "a status line shorter than a field label",
      target: "status",
      mutation: "status-short-line",
      succeeds: true,
    },
    {
      label: "a status value shorter than the expected field",
      target: "status",
      mutation: "status-value-overrun",
      succeeds: false,
    },
    {
      label: "a mismatched status field token",
      target: "status",
      mutation: "status-token-mismatch",
      succeeds: false,
    },
    {
      label: "a carriage-return status field delimiter",
      target: "status",
      mutation: "status-cr",
      succeeds: true,
    },
    {
      label: "a mismatched tcp header",
      target: "tcp",
      mutation: "header-mismatch",
      succeeds: false,
    },
    {
      label: "a tcp header with too few tokens",
      target: "tcp",
      mutation: "short-header",
      succeeds: false,
    },
    {
      label: "more than 32 tcp tokens",
      target: "tcp",
      mutation: "too-many-tokens",
      succeeds: false,
    },
    {
      label: "a short tcp data row",
      target: "tcp",
      mutation: "short-data",
      succeeds: false,
    },
    {
      label: "a malformed tcp sequence number",
      target: "tcp",
      mutation: "sl-mismatch",
      succeeds: false,
    },
    {
      label: "a valid lowercase tcp hexadecimal digit",
      target: "tcp",
      mutation: "hex-lowercase",
      succeeds: false,
    },
    {
      label: "an invalid tcp hexadecimal digit",
      target: "tcp",
      mutation: "hex-invalid",
      succeeds: false,
    },
    {
      label: "a wildcard listener on the configured port",
      target: "tcp",
      mutation: "wildcard",
      succeeds: false,
    },
    {
      label: "a configured listener owned by another uid",
      target: "tcp",
      mutation: "uid-mismatch",
      succeeds: false,
    },
    {
      label: "a configured listener owned by another inode",
      target: "tcp",
      mutation: "inode-mismatch",
      succeeds: false,
    },
    {
      label: "an empty size-zero tcp snapshot",
      target: "tcp",
      mutation: "empty",
      succeeds: false,
    },
  ];

  it.each(terminalParserFaultCases)(
    "handles captured-native $label without trusting altered proc content",
    async (testCase): Promise<void> => {
      const fixture = createCapturedReaderFixture();
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
      const targetPath = testCase.target === "tcp"
        ? join(fixture.procRoot, "net", "tcp")
        : join(fixture.procRoot, "5252", testCase.target);
      let exactRecoveryBytes = "";
      let signalCallsBefore = 0;
      let ensureCallsBefore = 0;
      let tokenReadsBefore = 0;
      let replacementCalls = 0;
      let emptyReads = 0;
      fs.tokenReadTarget = fixture.tokenFile;

      try {
        const result = await restartDaemonProduction({
          ...fixture.options,
          _offlineRecoveryBoundaryOverride: (phase: string): void => {
            if (phase === "before-record-cleanup") {
              exactRecoveryBytes = readFileSync(recordPath, "utf8");
            }
            if (phase !== "before-terminal-restart-publication") return;
            signalCallsBefore = fixture.killProcess.mock.calls.length;
            ensureCallsBefore = fixture.ensureReplacement.mock.calls.length;
            tokenReadsBefore = fs.tokenContentReadCalls;
            if (testCase.mutation === "empty") {
              fs.terminalEmptyDynamicTarget = targetPath;
            } else {
              fs.terminalReadReplacementTarget = targetPath;
              fs.terminalReadReplacementBytes = terminalParserReplacement(
                targetPath,
                testCase.mutation,
              );
            }
          },
        });

        replacementCalls = fs.terminalReadReplacementCalls;
        emptyReads = fs.terminalEmptyDynamicReadCalls;
        expect(fixture.killProcess).toHaveBeenCalledTimes(signalCallsBefore);
        expect(fixture.ensureReplacement).toHaveBeenCalledTimes(ensureCallsBefore);
        expect(fs.tokenContentReadCalls).toBe(tokenReadsBefore);
        expect(readFileSync(fixture.pidFile, "utf8")).toBe("5252");
        expect(readFileSync(fixture.tokenFile, "utf8")).toBe("local-token");
        if (testCase.succeeds) {
          expect(result).toMatchObject({ connected: true, restarted: true, pid: 5252 });
          expect(lstatSync(recordPath, { throwIfNoEntry: false })).toBeUndefined();
          expect(lstatSync(quarantinePath, { throwIfNoEntry: false })).toBeUndefined();
        } else {
          expect(result).toMatchObject({
            connected: false,
            restarted: false,
            pid: 5252,
            stoppedPid: 4242,
            warning: expect.stringContaining("terminal callback-free replacement"),
          });
          expect(readFileSync(quarantinePath, "utf8")).toBe(exactRecoveryBytes);
        }
      } finally {
        fs.terminalReadReplacementTarget = null;
        fs.terminalReadReplacementBytes = null;
        fs.terminalReadReplacementCalls = 0;
        fs.terminalEmptyDynamicTarget = null;
        fs.terminalEmptyDynamicReadCalls = 0;
        fs.tokenReadTarget = null;
        fs.tokenContentReadCalls = 0;
      }

      expect(exactRecoveryBytes).not.toBe("");
      expect(replacementCalls).toBe(
        testCase.mutation === "empty" ? 0 : testCase.succeeds ? 2 : 1,
      );
      expect(emptyReads).toBe(testCase.mutation === "empty" ? 1 : 0);
      expect(fs.descriptorPaths.size).toBe(0);
      expect(fs.descriptorFstatCalls.size).toBe(0);
      expect(fs.descriptorReadCalls.size).toBe(0);
    },
  );

  it.each([
    ["loopback", "0000000000000000FFFF00000100007F", true],
    ["wildcard", "00000000000000000000000000000000", false],
  ] as const)(
    "handles a captured-native IPv6 $label listener without weakening ownership",
    async (_label: string, address: string, succeeds: boolean): Promise<void> => {
      const fixture = createCapturedReaderFixture();
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
      const tcpHeader = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode";
      let exactRecoveryBytes = "";
      let tokenReadsBefore = 0;
      fs.tokenReadTarget = fixture.tokenFile;

      try {
        const result = await restartDaemonProduction({
          ...fixture.options,
          _offlineRecoveryBoundaryOverride: (phase: string): void => {
            if (phase === "before-record-cleanup") {
              exactRecoveryBytes = readFileSync(recordPath, "utf8");
            }
            if (phase !== "before-terminal-restart-publication") return;
            tokenReadsBefore = fs.tokenContentReadCalls;
            writeFileSync(join(fixture.procRoot, "net", "tcp"), `${tcpHeader}\n`);
            writeFileSync(join(fixture.procRoot, "net", "tcp6"), [
              tcpHeader,
              `   0: ${address}:4E1F 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12345`,
              "",
            ].join("\n"));
          },
        });

        expect(fs.tokenContentReadCalls).toBe(tokenReadsBefore);
        expect(readWithoutTokenAccounting(
          () => readFileSync(fixture.tokenFile, "utf8"),
        )).toBe("local-token");
        if (succeeds) {
          expect(result).toMatchObject({ connected: true, restarted: true, pid: 5252 });
          expect(lstatSync(recordPath, { throwIfNoEntry: false })).toBeUndefined();
          expect(lstatSync(quarantinePath, { throwIfNoEntry: false })).toBeUndefined();
        } else {
          expect(result).toMatchObject({
            connected: false,
            restarted: false,
            pid: 5252,
            stoppedPid: 4242,
            warning: expect.stringContaining("terminal callback-free replacement"),
          });
          expect(readFileSync(quarantinePath, "utf8")).toBe(exactRecoveryBytes);
        }
      } finally {
        fs.tokenReadTarget = null;
        fs.tokenContentReadCalls = 0;
      }

      expect(exactRecoveryBytes).not.toBe("");
      expect(fs.descriptorPaths.size).toBe(0);
      expect(fs.descriptorFstatCalls.size).toBe(0);
      expect(fs.descriptorReadCalls.size).toBe(0);
    },
  );

  it.each([
    ["exact negative count", "cmdline", "invalid-negative-count"],
    ["exact over-request count", "cmdline", "invalid-overread-count"],
    ["dynamic negative count", "stat", "invalid-negative-count"],
    ["dynamic over-request count", "stat", "invalid-overread-count"],
  ] as const)(
    "refuses terminal publication after captured-native %s",
    async (
      _label: string,
      leaf: "cmdline" | "stat",
      fault: "invalid-negative-count" | "invalid-overread-count",
    ): Promise<void> => {
      const fixture = createCapturedReaderFixture();
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
      const lifecycleMutation = vi.fn();
      let exactRecoveryBytes = "";
      let invalidReadObserved = false;
      let faultedDescriptor: number | null = null;
      let faultedDescriptorClosedBeforeReset = false;
      let faultedReadCall = 0;
      let signalCallsAtFault: number | undefined;
      let spawnCallsAtFault: number | undefined;
      let tokenReadsAtFault: number | undefined;
      let tokenReadsAfter = 0;
      let lifecycleMutationsAtFault: number | undefined;
      let result: Awaited<ReturnType<typeof restartDaemonProduction>> | undefined;
      let restartError: unknown;

      fs.tokenReadTarget = fixture.tokenFile;
      fs.terminalInvalidRead = (): void => {
        invalidReadObserved = true;
        faultedDescriptor = fs.terminalFaultDescriptor;
        faultedReadCall = faultedDescriptor === null
          ? 0
          : fs.descriptorReadCalls.get(faultedDescriptor) ?? 0;
        signalCallsAtFault = fixture.killProcess.mock.calls.length;
        spawnCallsAtFault = fixture.ensureReplacement.mock.calls.length;
        tokenReadsAtFault = fs.tokenContentReadCalls;
        lifecycleMutationsAtFault = lifecycleMutation.mock.calls.length;
      };

      try {
        result = await restartDaemonProduction({
          ...fixture.options,
          _offlinePidUnlinkOverride: (): void => {
            lifecycleMutation("pid-unlink");
          },
          _offlineRecordUnlinkOverride: (): void => {
            lifecycleMutation("record-unlink");
          },
          _offlineRecoveryBackupUnlinkOverride: (): void => {
            lifecycleMutation("backup-unlink");
          },
          _offlineRecoveryFinalizeOverride: (): void => {
            lifecycleMutation("finalize");
          },
          _offlineRecoveryBoundaryOverride: (phase: string): void => {
            if (phase === "before-record-cleanup") {
              exactRecoveryBytes = readFileSync(recordPath, "utf8");
            }
            if (phase !== "before-terminal-restart-publication") return;
            fs.terminalTarget = join(fixture.procRoot, "5252", leaf);
            fs.terminalFault = fault;
          },
        });
      } catch (error) {
        restartError = error;
      } finally {
        tokenReadsAfter = fs.tokenContentReadCalls;
        faultedDescriptorClosedBeforeReset = faultedDescriptor !== null
          && fs.descriptorCloseCalls.has(faultedDescriptor)
          && !fs.descriptorPaths.has(faultedDescriptor)
          && !fs.descriptorFstatCalls.has(faultedDescriptor)
          && !fs.descriptorReadCalls.has(faultedDescriptor);
        fs.terminalFault = null;
        fs.terminalTarget = null;
        fs.terminalFaultDescriptor = null;
        fs.terminalFaultConsumed = false;
        fs.terminalInvalidRead = null;
        fs.tokenReadTarget = null;
        fs.tokenContentReadCalls = 0;
        fs.descriptorPaths.clear();
        fs.descriptorFstatCalls.clear();
        fs.descriptorReadCalls.clear();
        fs.descriptorCloseCalls.clear();
      }

      expect(restartError).toBeUndefined();
      expect(invalidReadObserved).toBe(true);
      expect(faultedDescriptor).not.toBeNull();
      expect(faultedDescriptorClosedBeforeReset).toBe(true);
      expect(faultedReadCall).toBe(1);
      expect(signalCallsAtFault).toBeDefined();
      expect(spawnCallsAtFault).toBeDefined();
      expect(tokenReadsAtFault).toBeDefined();
      expect(lifecycleMutationsAtFault).toBeDefined();
      expect(result).toMatchObject({
        connected: false,
        restarted: false,
        pid: 5252,
        stoppedPid: 4242,
        warning: expect.stringContaining("terminal callback-free replacement"),
      });
      expect(fixture.killProcess).toHaveBeenCalledTimes(signalCallsAtFault ?? -1);
      expect(fixture.ensureReplacement).toHaveBeenCalledTimes(spawnCallsAtFault ?? -1);
      expect(tokenReadsAfter).toBe(tokenReadsAtFault);
      expect(lifecycleMutation).toHaveBeenCalledTimes(lifecycleMutationsAtFault ?? -1);
      expect(readFileSync(fixture.pidFile, "utf8")).toBe("5252");
      expect(readFileSync(fixture.tokenFile, "utf8")).toBe("local-token");
      expect(readFileSync(quarantinePath, "utf8")).toBe(exactRecoveryBytes);
      expect(result?.warning).toContain("exact durable recovery backup was restored or preserved");
      expect(result?.warning).not.toContain("authority or durability is indeterminate");
    },
  );

  it("accepts complete positive proc evidence when captured fstat reports size zero", async () => {
    const fixture = createCapturedReaderFixture();
    const boundaries: string[] = [];
    const result = await restartDaemonProduction({
      ...fixture.options,
      _offlineRecoveryBoundaryOverride: (phase: string): void => {
        boundaries.push(phase);
        if (phase !== "before-terminal-restart-publication") return;
        fs.terminalTarget = join(fixture.procRoot, "5252", "stat");
        fs.terminalFault = "size-zero";
      },
    });

    expect(boundaries).toContain("before-terminal-restart-publication");
    expect(result).toMatchObject({ connected: true, restarted: true, pid: 5252 });
    expect(readFileSync(fixture.pidFile, "utf8")).toBe("5252");
    expect(readFileSync(fixture.tokenFile, "utf8")).toBe("local-token");
  });

  it.each([
    ["parent proof", "parent-proof", false, false],
    ["parent procfd identity", "parent-realpath", false, false],
    ["source open", "source-open", false, false],
    ["source open plus parent close", "source-open-parent-close", false, false],
    ["source read", "source-read", false, false],
    ["source proof", "source-proof", false, false],
    ["quarantine lstat", "quarantine-lstat-error", false, false],
    ["occupied quarantine", "canonical-source-present", false, false],
    ["link EEXIST", "link-eexist", false, false],
    ["link failure", "link-error", false, false],
    ["source reopen", "source-reopen", true, false],
    ["quarantine open", "quarantine-open", true, false],
    ["linked source read", "source-linked-read", true, false],
    ["linked quarantine read", "quarantine-linked-read", true, false],
    ["linked source proof", "source-linked-proof", true, false],
    ["linked quarantine proof", "quarantine-linked-proof", true, false],
    ["source unlink", "source-unlink", true, false],
    ["source post-unlink proof", "source-post-proof", false, true],
    ["quarantine post-unlink proof", "quarantine-post-proof", false, true],
    ["canonical source lstat", "source-post-lstat-error", false, true],
    ["canonical source occupancy", "source-post-present", false, true],
    ["parent fsync", "parent-fsync", false, true],
    ["parent post-fsync proof", "parent-post-proof", false, true],
    ["parent post-fsync procfd", "parent-post-realpath", false, true],
    ["canonical parent open", "canonical-parent-open", false, true],
    ["canonical parent proof", "canonical-parent-proof", false, true],
    ["canonical parent close", "canonical-parent-close", false, true],
    ["quarantine descriptor close", "quarantine-close", false, true],
    ["source descriptor close", "source-close", false, true],
    ["parent descriptor close", "parent-close", false, true],
    ["post-close quarantine open", "postclose-quarantine-open", false, false, true],
  ] as const)(
    "handles captured-native PID quarantine %s failure without overwriting evidence",
    async (
      _label: string,
      fault: PidQuarantineNativeFault,
      expectsTwoLinks: boolean,
      expectsRecoveredSuccess: boolean,
      expectsCanonicalAbsent?: boolean,
    ): Promise<void> => {
      const fixture = createCapturedReaderFixture();
      const hermeticSeams = fixture.options._hermeticTestSeams;
      if (hermeticSeams === undefined) {
        throw new Error("captured hermetic seams are unavailable");
      }
      const recordPath = join(fixture.root, ".daemon.pid.restart-recovery.json");
      const quarantinePath = join(fixture.root, ".daemon.pid.restart-quarantine");
      let originalAlive = true;
      const retainedKill = vi.fn((pid: number, signal?: NodeJS.Signals | number): void => {
        if (pid !== 4242 || signal !== "SIGTERM") return;
        originalAlive = false;
        rmSync(join(fixture.procRoot, "4242"), { recursive: true, force: true });
      });
      const retainedAlive = (pid: number): boolean => pid === 4242
        ? originalAlive
        : lstatSync(
          join(fixture.procRoot, String(pid)),
          { throwIfNoEntry: false },
        )?.isDirectory() === true;
      let result: Awaited<ReturnType<typeof restartDaemonProduction>> | undefined;
      let restartError: unknown;

      try {
        result = await restartDaemonProduction({
          ...fixture.options,
          _killOverride: retainedKill,
          _isProcessAliveOverride: retainedAlive,
          _hermeticTestSeams: {
            ...hermeticSeams,
            killProcess: retainedKill,
            isProcessAlive: retainedAlive,
          },
          _offlineRecoveryBoundaryOverride: (phase: string): void => {
            if (phase !== "before-pid-quarantine") return;
            fs.pidQuarantineRoot = fixture.root;
            fs.pidQuarantinePidPath = fixture.pidFile;
            fs.pidQuarantinePath = quarantinePath;
            fs.pidQuarantineParentOpenOrdinal = 42;
            fs.pidQuarantineFault = fault;
          },
        });
      } catch (error) {
        restartError = error;
      }

      expect(fs.pidQuarantineFaultCalls).toBe(
        fault === "source-open-parent-close" ? 2 : 1,
      );
      expect(retainedKill).toHaveBeenCalledOnce();
      expect(readWithoutTokenAccounting(
        () => readFileSync(fixture.tokenFile, "utf8"),
      )).toBe("local-token");
      expect(fs.descriptorPaths.size).toBe(0);
      expect(fs.descriptorFstatCalls.size).toBe(0);
      expect(fs.descriptorReadCalls.size).toBe(0);
      expect(fs.pidQuarantineDescriptorRoles.size).toBe(0);
      expect(fs.pidQuarantineFstatCalls.size).toBe(0);
      expect(fs.pidQuarantineReadCalls.size).toBe(0);

      if (expectsRecoveredSuccess) {
        expect(restartError).toBeUndefined();
        expect(result).toMatchObject({ connected: true, restarted: true, pid: 5252 });
        expect(fixture.ensureReplacement).toHaveBeenCalledOnce();
        expect(readFileSync(fixture.pidFile, "utf8")).toBe("5252");
        expect(lstatSync(recordPath, { throwIfNoEntry: false })).toBeUndefined();
        expect(lstatSync(quarantinePath, { throwIfNoEntry: false })).toBeUndefined();
      } else {
        expect(result).toBeUndefined();
        expect(restartError).toBeInstanceOf(Error);
        expect(String(restartError)).toContain("Offline restart recovery refused for PID 4242");
        expect(fixture.ensureReplacement).not.toHaveBeenCalled();
        expect(readFileSync(recordPath, "utf8")).toContain("\"pid\":4242");
        if (expectsCanonicalAbsent === true) {
          expect(lstatSync(fixture.pidFile, { throwIfNoEntry: false })).toBeUndefined();
          expect(readFileSync(quarantinePath, "utf8")).toBe("4242");
          expect(lstatSync(quarantinePath).nlink).toBe(1);
        } else if (expectsTwoLinks) {
          expect(readFileSync(quarantinePath, "utf8")).toBe("4242");
          expect(lstatSync(fixture.pidFile).nlink).toBe(2);
          expect(lstatSync(quarantinePath).nlink).toBe(2);
          expect(lstatSync(fixture.pidFile).ino).toBe(lstatSync(quarantinePath).ino);
        } else {
          expect(readFileSync(fixture.pidFile, "utf8")).toBe("4242");
          expect(lstatSync(quarantinePath, { throwIfNoEntry: false })).toBeUndefined();
          expect(lstatSync(fixture.pidFile).nlink).toBe(1);
        }
      }
    },
  );
});
