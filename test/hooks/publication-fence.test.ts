import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertHookPublicationFence,
  assertHookRootEstablished,
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
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
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
    const read = vi.spyOn(backendPublication, "readBackendPublicationJournal").mockReturnValue({
      phase: "preparing",
    } as never);
    try {
      expect(() => assertHookPublicationFence()).toThrow("backend publication is unresolved");
    } finally {
      read.mockRestore();
    }
  });

  it("classifies and rethrows only publication journal errors", () => {
    const publicationError = new BackendPublicationJournalError("malformed-journal", "bad journal");
    expect(isBackendPublicationJournalError(publicationError)).toBe(true);
    expect(isBackendPublicationJournalError(new Error("ordinary"))).toBe(false);
    expect(() => rethrowBackendPublicationJournalError(new Error("ordinary"))).not.toThrow();
    expect(() => rethrowBackendPublicationJournalError(publicationError)).toThrow(publicationError);
  });
});
