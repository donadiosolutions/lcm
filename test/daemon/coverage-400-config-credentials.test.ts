import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  fstatSync: vi.fn(),
  lstatSync: vi.fn(),
  mkdirSync: vi.fn(),
  realpathSync: vi.fn(),
  rmdirSync: vi.fn(),
  unlinkSync: vi.fn(),
  originals: undefined as typeof import("node:fs") | undefined,
}));
const pathMocks = vi.hoisted(() => ({
  originals: undefined as typeof import("node:path") | undefined,
  resolve: vi.fn(),
}));

vi.mock("node:fs", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs")>();
  fsMocks.originals = original;
  const forward = (fn: (...args: any[]) => any) => (...args: any[]) => Reflect.apply(fn, original, args);
  fsMocks.fstatSync.mockImplementation(forward(original.fstatSync as (...args: any[]) => any));
  fsMocks.lstatSync.mockImplementation(forward(original.lstatSync as (...args: any[]) => any));
  fsMocks.mkdirSync.mockImplementation(forward(original.mkdirSync as (...args: any[]) => any));
  fsMocks.realpathSync.mockImplementation(forward(original.realpathSync as (...args: any[]) => any));
  fsMocks.rmdirSync.mockImplementation(forward(original.rmdirSync as (...args: any[]) => any));
  fsMocks.unlinkSync.mockImplementation(forward(original.unlinkSync as (...args: any[]) => any));
  return {
    ...original,
    fstatSync: fsMocks.fstatSync,
    lstatSync: fsMocks.lstatSync,
    mkdirSync: fsMocks.mkdirSync,
    realpathSync: fsMocks.realpathSync,
    rmdirSync: fsMocks.rmdirSync,
    unlinkSync: fsMocks.unlinkSync,
  };
});

vi.mock("node:path", async importOriginal => {
  const original = await importOriginal<typeof import("node:path")>();
  pathMocks.originals = original;
  pathMocks.resolve.mockImplementation((...args: any[]) => Reflect.apply(original.resolve, original, args));
  return { ...original, resolve: pathMocks.resolve };
});

import { parseDaemonConfig, parseLlmRequestPolicyConfig, resolveDaemonConfigEnv } from "../../src/daemon/config.js";
import {
  cleanupManagedCredentialDirectory,
  createManagedCredentialDirectory,
  managedCredentialPath,
  validateManagedCredentialDirectory,
  writeManagedCredentialFiles,
} from "../../src/daemon/managed-credentials.js";

const originalGetuid = Object.getOwnPropertyDescriptor(process, "getuid");

function restoreFsForwarders(): void {
  const original = fsMocks.originals;
  if (original === undefined) throw new Error("node:fs mock was not initialized");
  const forward = (fn: (...args: any[]) => any) => (...args: any[]) => Reflect.apply(fn, original, args);
  fsMocks.fstatSync.mockImplementation(forward(original.fstatSync as (...args: any[]) => any));
  fsMocks.lstatSync.mockImplementation(forward(original.lstatSync as (...args: any[]) => any));
  fsMocks.mkdirSync.mockImplementation(forward(original.mkdirSync as (...args: any[]) => any));
  fsMocks.realpathSync.mockImplementation(forward(original.realpathSync as (...args: any[]) => any));
  fsMocks.rmdirSync.mockImplementation(forward(original.rmdirSync as (...args: any[]) => any));
  fsMocks.unlinkSync.mockImplementation(forward(original.unlinkSync as (...args: any[]) => any));
}

function restorePathForwarder(): void {
  const original = pathMocks.originals;
  if (original === undefined) throw new Error("node:path mock was not initialized");
  pathMocks.resolve.mockImplementation((...args: any[]) => Reflect.apply(original.resolve, original, args));
}

function setGetuid(value: (() => number) | undefined): void {
  Object.defineProperty(process, "getuid", { configurable: true, value });
}

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "lcm-400-config-credentials-"));
}

function removeRoot(root: string): void {
  chmodSync(root, 0o700);
  rmSync(root, { recursive: true, force: true });
}

function errorWithCode(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

beforeEach(() => {
  restoreFsForwarders();
  restorePathForwarder();
  vi.clearAllMocks();
});

afterEach(() => {
  restoreFsForwarders();
  restorePathForwarder();
  if (originalGetuid === undefined) Reflect.deleteProperty(process, "getuid");
  else Object.defineProperty(process, "getuid", originalGetuid);
  vi.restoreAllMocks();
});

describe("Epic 400 configuration credential-loader coverage", () => {
  it("covers the default LLM request-policy fallback branches", () => {
    expect(parseLlmRequestPolicyConfig("{}")).toEqual({
      llm: {
        provider: "auto",
        requestTimeoutMs: 600_000,
        retry: {
          maxAttempts: 3,
          initialDelayMs: 1_000,
          maxDelayMs: 30_000,
          multiplier: 2,
        },
      },
    });
  });

  it("covers PostgreSQL CA path, read, and empty-content validation", () => {
    const base = { storage: { backend: "postgresql" } };
    const env = { LCM_POSTGRES_URL: "postgresql://user:password@db.example.com/lcm" };
    expect(() => parseDaemonConfig("{}", base, { ...env, LCM_POSTGRES_CA_FILE: "relative.crt" })).toThrow("absolute path");
    expect(() => parseDaemonConfig("{}", base, { ...env, LCM_POSTGRES_CA_FILE: "/missing/lcm-ca.crt" })).toThrow("readable regular file");

    const root = makeRoot();
    const emptyCa = join(root, "ca.crt");
    writeFileSync(emptyCa, "");
    try {
      expect(() => parseDaemonConfig("{}", base, { ...env, LCM_POSTGRES_CA_FILE: emptyCa })).toThrow("must not be empty");
    } finally {
      removeRoot(root);
    }
  });

  it("covers invalid numeric UIDs while resolving the system credential prefix", () => {
    const directory = "/run/credentials/lcm-coverage.service";
    setGetuid(() => Number.NaN);
    fsMocks.lstatSync.mockImplementation((path: string) => {
      if (path === directory) {
        return {
          dev: 1,
          ino: 2,
          uid: 0,
          mode: 0o40500,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        };
      }
      return fsMocks.originals!.lstatSync(path);
    });
    fsMocks.realpathSync.mockImplementation((path: string) => path);

    expect(resolveDaemonConfigEnv({ CREDENTIALS_DIRECTORY: directory })).toEqual({ CREDENTIALS_DIRECTORY: directory });
  });

  it("uses launchd UID fallbacks and rejects non-canonical directories and leaves", () => {
    const root = makeRoot();
    const directory = join(root, "credentials");
    const file = join(directory, "OPENAI_API_KEY");
    const link = join(root, "credentials-link");
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
    writeFileSync(file, "launchd-fallback\n", { mode: 0o600 });
    chmodSync(file, 0o600);
    setGetuid(undefined);
    try {
      const env = {
        LCM_CREDENTIAL_DIRECTORY: directory,
        LCM_CREDENTIAL_OPENAI_API_KEY_FILE: file,
      };
      expect(resolveDaemonConfigEnv(env).OPENAI_API_KEY).toBe("launchd-fallback");

      symlinkSync(directory, link, "dir");
      expect(resolveDaemonConfigEnv({
        LCM_CREDENTIAL_DIRECTORY: link,
        LCM_CREDENTIAL_OPENAI_API_KEY_FILE: join(link, "OPENAI_API_KEY"),
      }).OPENAI_API_KEY).toBeUndefined();

      writeFileSync(file, "canonical-race\n", { mode: 0o600 });
      chmodSync(file, 0o600);
      fsMocks.realpathSync.mockImplementation((path: string) =>
        path === file ? join(root, "escaped", "OPENAI_API_KEY") : fsMocks.originals!.realpathSync(path),
      );
      expect(resolveDaemonConfigEnv(env).OPENAI_API_KEY).toBeUndefined();
    } finally {
      removeRoot(root);
    }
  });
});

describe("Epic 400 managed credential coverage", () => {
  it("covers canonical and existing-directory creation races", () => {
    const root = makeRoot();
    try {
      fsMocks.realpathSync.mockImplementationOnce(() => `${resolve(root)}-not-canonical`);
      expect(() => createManagedCredentialDirectory(root, "canonical-race")).toThrow("not canonical");
      restoreFsForwarders();

      const first = createManagedCredentialDirectory(root, "first");
      const second = createManagedCredentialDirectory(root, "second");
      expect(first).not.toBe(second);
      expect(createManagedCredentialDirectory(root, "second")).toBe(second);
      chmodSync(join(root, "credentials"), 0o755);
      expect(createManagedCredentialDirectory(root, "tightened")).toContain(join(root, "credentials"));
      expect(statSync(join(root, "credentials")).mode & 0o777).toBe(0o700);
      cleanupManagedCredentialDirectory(first, root);
      cleanupManagedCredentialDirectory(second, root);
      cleanupManagedCredentialDirectory(join(root, "credentials", "tightened"), root);

      mkdirSync(join(root, "credentials", "non-normalized"), { mode: 0o700 });
      pathMocks.resolve.mockImplementation((...args: any[]) => {
        const original = pathMocks.originals!;
        const value = Reflect.apply(original.resolve, original, args);
        return args.length === 2 && args[1] === "non-normalized" ? `${value}/.` : value;
      });
      expect(() => createManagedCredentialDirectory(root, "non-normalized")).toThrow("escapes state root");
    } finally {
      removeRoot(root);
    }
  });

  it("covers descriptor write validation and canonical leaf escape checks", () => {
    const root = makeRoot();
    try {
      const directory = createManagedCredentialDirectory(root, "write-validation");
      fsMocks.fstatSync.mockImplementationOnce(() => ({
        isFile: () => false,
        mode: 0o100600,
        uid: typeof process.getuid === "function" ? process.getuid() : 0,
      }));
      expect(() => writeManagedCredentialFiles(directory, { OPENAI_API_KEY: "not-published" })).toThrow("validation");
      restoreFsForwarders();
      cleanupManagedCredentialDirectory(directory, root);

      const escapedDirectory = createManagedCredentialDirectory(root, "leaf-escape");
      writeManagedCredentialFiles(escapedDirectory, { OPENAI_API_KEY: "secret" });
      const file = managedCredentialPath(escapedDirectory, "OPENAI_API_KEY");
      fsMocks.realpathSync.mockImplementation((path: string) =>
        path === file ? join(root, "outside", "OPENAI_API_KEY") : fsMocks.originals!.realpathSync(path),
      );
      expect(() => validateManagedCredentialDirectory(escapedDirectory, root)).toThrow("escapes directory");
      restoreFsForwarders();
      cleanupManagedCredentialDirectory(escapedDirectory, root);
    } finally {
      removeRoot(root);
    }
  });

  it("covers ENOENT and hard failures while cleaning managed credential leaves", () => {
    const root = makeRoot();
    try {
      const unlinkFailure = createManagedCredentialDirectory(root, "unlink-failure");
      writeManagedCredentialFiles(unlinkFailure, { OPENAI_API_KEY: "secret" });
      fsMocks.unlinkSync.mockImplementationOnce(() => { throw errorWithCode("EACCES"); });
      expect(() => cleanupManagedCredentialDirectory(unlinkFailure, root)).toThrow("cleanup failed");
      restoreFsForwarders();
      cleanupManagedCredentialDirectory(unlinkFailure, root);

      const unlinkMissing = createManagedCredentialDirectory(root, "unlink-missing");
      writeManagedCredentialFiles(unlinkMissing, { OPENAI_API_KEY: "secret" });
      fsMocks.unlinkSync.mockImplementationOnce(() => { throw errorWithCode("ENOENT"); });
      fsMocks.rmdirSync.mockImplementationOnce(() => { throw errorWithCode("EACCES"); });
      expect(() => cleanupManagedCredentialDirectory(unlinkMissing, root)).toThrow("cleanup failed");
      restoreFsForwarders();
      cleanupManagedCredentialDirectory(unlinkMissing, root);

      const rmdirMissing = createManagedCredentialDirectory(root, "rmdir-missing");
      fsMocks.rmdirSync.mockImplementationOnce(() => { throw errorWithCode("ENOENT"); });
      expect(() => cleanupManagedCredentialDirectory(rmdirMissing, root)).not.toThrow();
      restoreFsForwarders();
      cleanupManagedCredentialDirectory(rmdirMissing, root);
    } finally {
      removeRoot(root);
    }
  });

  it("covers managed creation, containment, and path rejection fences", () => {
    const root = makeRoot();
    const outsideBase = mkdtempSync(join(tmpdir(), "lcm-400-managed-outside-"));
    try {
      fsMocks.mkdirSync.mockImplementationOnce(() => { throw errorWithCode("EACCES"); });
      expect(() => createManagedCredentialDirectory(root, "base-failure")).toThrow("cannot be created");
      restoreFsForwarders();

      mkdirSync(join(root, "credentials"), { mode: 0o700 });
      pathMocks.resolve.mockImplementation((...args: any[]) => {
        const original = pathMocks.originals!;
        if (args.length === 2 && args[1] === "credentials") return outsideBase;
        return Reflect.apply(original.resolve, original, args);
      });
      expect(() => createManagedCredentialDirectory(root, "base-escape")).toThrow("path escapes state root");
      restorePathForwarder();

      const directory = createManagedCredentialDirectory(root, "directory-failure");
      let mkdirCalls = 0;
      fsMocks.mkdirSync.mockImplementation((...args: any[]) => {
        mkdirCalls += 1;
        if (mkdirCalls === 2) throw errorWithCode("EACCES");
        return Reflect.apply(fsMocks.originals!.mkdirSync, fsMocks.originals, args);
      });
      expect(() => createManagedCredentialDirectory(root, "directory-failure-2")).toThrow("cannot be created");
      restoreFsForwarders();
      cleanupManagedCredentialDirectory(directory, root);

      const pathDirectory = createManagedCredentialDirectory(root, "path-failure");
      pathMocks.resolve.mockImplementation((...args: any[]) => {
        const original = pathMocks.originals!;
        if (args.length === 2 && args[1] === "OPENAI_API_KEY") return join(outsideBase, "OPENAI_API_KEY");
        return Reflect.apply(original.resolve, original, args);
      });
      expect(() => managedCredentialPath(pathDirectory, "OPENAI_API_KEY")).toThrow("path escapes directory");
      restorePathForwarder();
      cleanupManagedCredentialDirectory(pathDirectory, root);
    } finally {
      removeRoot(root);
      rmSync(outsideBase, { recursive: true, force: true });
    }
  });
});
