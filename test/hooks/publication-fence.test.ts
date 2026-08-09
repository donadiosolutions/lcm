import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertHookPublicationFence,
  assertHookRootEstablished,
  isBackendPublicationEvidenceMissing,
  isBackendPublicationJournalError,
  rethrowBackendPublicationJournalError,
  withHookPublicationFence,
  withHookPublicationFenceAsync,
  assertHookPublicationFenceToken,
} from "../../src/hooks/publication-fence.js";
import {
  BackendPublicationJournalError,
  backendPublicationDirectory,
  backendPublicationJournalPath,
} from "../../src/storage/backend-publication.js";
import * as backendPublication from "../../src/storage/backend-publication.js";
import * as securityFiles from "../../src/security-files.js";

describe("hook publication fence", () => {
  let previousHome: string | undefined;
  let home: string;

  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "lcm-publication-fence-home-"));
    process.env.HOME = home;
    mkdirSync(join(home, ".lcm"), { mode: 0o700 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("uses the coordinator consumer lock and token semantics", () => {
    const consumerLock = vi.spyOn(backendPublication, "withBackendPublicationConsumerLock");

    expect(() => withHookPublicationFence((lockToken) => {
      backendPublication.assertBackendPublicationConsumerAccess({
        homeDir: home,
        lockToken,
      });
    })).not.toThrow();

    expect(consumerLock).toHaveBeenCalledWith(home, expect.any(Function));
  });

  it("fails closed when publication evidence remains without a journal", () => {
    const directory = backendPublicationDirectory();
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(join(directory, "orphan.material"), "orphan", { mode: 0o600 });

    expect(() => assertHookPublicationFence()).toThrow("publication evidence is incomplete");
  });

  it("passes explicit absent config and project-map observations to approved evidence APIs", () => {
    const configAccess = vi.spyOn(backendPublication, "assertBackendPublicationConfigAccess");
    const projectMapAccess = vi.spyOn(backendPublication, "assertBackendPublicationProjectMapAccess");

    expect(() => assertHookPublicationFence()).not.toThrow();

    expect(configAccess).toHaveBeenCalledWith(
      join(home, ".lcm", "config.json"),
      "sqlite",
      null,
      undefined,
      expect.anything(),
    );
    expect(projectMapAccess).toHaveBeenCalledWith(expect.objectContaining({
      homeDir: home,
      content: null,
      map: {},
      present: false,
      lockToken: expect.anything(),
    }));
  });

  it("fails closed when config evidence is not a regular file", () => {
    mkdirSync(join(home, ".lcm", "config.json"), { mode: 0o700 });

    expect(() => assertHookPublicationFence()).toThrow("regular file");
  });

  it("fails closed when config evidence is not valid JSON", () => {
    writeFileSync(join(home, ".lcm", "config.json"), "{", { mode: 0o600 });

    expect(() => assertHookPublicationFence()).toThrow(BackendPublicationJournalError);
  });

  it("treats an explicitly selected non-PostgreSQL config as SQLite evidence", () => {
    writeFileSync(
      join(home, ".lcm", "config.json"),
      JSON.stringify({ storage: { backend: "sqlite" } }),
      { mode: 0o600 },
    );

    expect(() => assertHookPublicationFence()).not.toThrow();
  });

  it("classifies an explicitly selected PostgreSQL config before admission", () => {
    writeFileSync(
      join(home, ".lcm", "config.json"),
      JSON.stringify({ storage: { backend: "postgresql" } }),
      { mode: 0o600 },
    );

    expect(() => assertHookPublicationFence()).toThrow("PostgreSQL selection");
  });

  it("fails closed when the project map is not valid JSON", () => {
    writeFileSync(join(home, ".lcm", "map.json"), "{", { mode: 0o600 });

    expect(() => assertHookPublicationFence()).toThrow(BackendPublicationJournalError);
  });

  it("fails closed when the config path cannot identify the canonical LCM home", () => {
    const homeForConfig = vi.spyOn(backendPublication, "backendPublicationHomeForConfigPath")
      .mockReturnValue(undefined);
    try {
      expect(() => assertHookPublicationFence()).toThrow("canonical LCM config path");
    } finally {
      homeForConfig.mockRestore();
    }
  });

  it("fails closed when the retained root witness changes at the hook boundary", () => {
    const originalAssert = securityFiles.assertPrivateDirectory;
    let calls = 0;
    const assert = vi.spyOn(securityFiles, "assertPrivateDirectory").mockImplementation((handle, path, expected) => {
      const actual = originalAssert(handle, path, expected);
      calls += 1;
      return calls === 2 ? { ...actual, ino: `${actual.ino}-changed` } : actual;
    });
    try {
      expect(() => withHookPublicationFence(() => undefined))
        .toThrow("private directory witness changed");
    } finally {
      assert.mockRestore();
    }
  });

  it("authenticates the established root and exposes a short-lived direct-action token", () => {
    expect(() => assertHookRootEstablished()).not.toThrow();
    const token = withHookPublicationFence((value) => value);
    expect(token).toBeTypeOf("object");
    expect(() => assertHookPublicationFence()).not.toThrow();
  });

  it("supports an async fenced action", async () => {
    await expect(withHookPublicationFenceAsync(async (token) => {
      await Promise.resolve();
      return token;
    })).resolves.toBeTypeOf("object");
  });

  it("rejects promise-returning callbacks at the synchronous fence", () => {
    expect(() => withHookPublicationFence(async () => undefined)).toThrow(
      "synchronous hook publication callback returned a promise",
    );
  });

  it("revokes direct-action tokens when the fence releases", () => {
    let token: Parameters<typeof assertHookPublicationFenceToken>[0] | undefined;
    withHookPublicationFence((value) => { token = value; });
    expect(() => assertHookPublicationFenceToken(token!)).toThrow("not active");
  });

  it("fails closed when the retained root is replaced during a direct action", () => {
    const root = join(home, ".lcm");
    const oldRoot = join(home, ".lcm.old");
    expect(() => withHookPublicationFence((token) => {
      renameSync(root, oldRoot);
      mkdirSync(root, { mode: 0o700 });
      assertHookPublicationFenceToken(token);
    })).toThrow(/private directory/);
    rmSync(root, { recursive: true, force: true });
    renameSync(oldRoot, root);
  });

  it("does not create a missing root", async () => {
    rmSync(join(home, ".lcm"), { recursive: true, force: true });
    expect(() => assertHookRootEstablished()).toThrow();
    expect(() => withHookPublicationFence(() => undefined)).toThrow();
    await expect(withHookPublicationFenceAsync(() => undefined)).rejects.toThrow();
    expect(existsSync(join(home, ".lcm"))).toBe(false);
  });

  it("fails closed for malformed publication state", () => {
    const directory = backendPublicationDirectory();
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(backendPublicationJournalPath(), "{", { mode: 0o600 });
    expect(() => assertHookPublicationFence()).toThrow(BackendPublicationJournalError);
  });

  it("fails closed for an unresolved publication journal", () => {
    const publicationError = new BackendPublicationJournalError(
      "unresolved-publication",
      "backend publication is unresolved",
    );
    const access = vi.spyOn(backendPublication, "assertBackendPublicationConsumerAccess")
      .mockImplementation(() => { throw publicationError; });
    try {
      expect(() => assertHookPublicationFence()).toThrow(publicationError);
    } finally {
      access.mockRestore();
    }
  });

  it("classifies and rethrows only publication journal errors", () => {
    const publicationError = new BackendPublicationJournalError("malformed-journal", "bad journal");
    const missingEvidence = new BackendPublicationJournalError(
      "publication-evidence-missing",
      "missing evidence",
    );
    expect(isBackendPublicationJournalError(publicationError)).toBe(true);
    expect(isBackendPublicationJournalError(new Error("ordinary"))).toBe(false);
    expect(isBackendPublicationEvidenceMissing(missingEvidence)).toBe(true);
    expect(isBackendPublicationEvidenceMissing(publicationError)).toBe(false);
    expect(isBackendPublicationEvidenceMissing(new Error("ordinary"))).toBe(false);
    expect(() => rethrowBackendPublicationJournalError(new Error("ordinary"))).not.toThrow();
    expect(() => rethrowBackendPublicationJournalError(publicationError)).toThrow(publicationError);
  });
});
