import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActivationArtifactPresenceUnresolvableError,
  ActivationArtifactUnsafeStorageError,
  ActivationArtifactValidationError,
  ActivationGenerationLinkConflictError,
  activationArtifactDirectory,
  activationGenerationLinkPath,
  readActivationGenerationLink,
  recordActivationGenerationLink,
  type ActivationGenerationLink,
} from "../../src/migration/activation-artifact-store.js";
import { readBoundedRegularFileWithStat } from "../../src/security-files.js";
import { canonicalJson, sha256 } from "../../src/storage/portable-record.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    // Best-effort mode restoration: permission-denial and
    // unauthenticated-directory fixtures leave non-0o700 modes behind that
    // would otherwise block recursive removal.
    try { chmodSync(root, 0o700); } catch { /* best-effort */ }
    try { chmodSync(join(root, ".lcm"), 0o700); } catch { /* best-effort */ }
    try { chmodSync(join(root, ".lcm", "migration-activation-material"), 0o700); } catch { /* best-effort */ }
    rmSync(root, { recursive: true, force: true });
  }
});

function home(): string {
  const value = mkdtempSync(join(tmpdir(), "lcm-activation-link-"));
  mkdirSync(join(value, ".lcm"), { mode: 0o700 });
  roots.push(value);
  return value;
}

function homeWithoutLcmRoot(): string {
  const value = mkdtempSync(join(tmpdir(), "lcm-activation-link-noroot-"));
  roots.push(value);
  return value;
}

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const CHECKSUM_C = "c".repeat(64);
const GENERATION = "generation-1";

type LinkInput = Omit<ActivationGenerationLink, "version">;

function linkInput(overrides: Partial<LinkInput> = {}): LinkInput {
  return {
    generationId: GENERATION,
    publicationId: "pub-1",
    identityDigest: DIGEST_A,
    epochManifestRevision: 5,
    epochManifestChecksumSha256: CHECKSUM_C,
    ...overrides,
  };
}

function expectedLink(overrides: Partial<ActivationGenerationLink> = {}): ActivationGenerationLink {
  return { version: 1, ...linkInput(), ...overrides };
}

/** This module's own canonical wire form of a link, built independently of
 * the module so the test pins the on-disk bytes rather than echoing them. */
function wireBytes(link: ActivationGenerationLink): string {
  return canonicalJson({
    version: link.version,
    generationId: link.generationId,
    publicationId: link.publicationId,
    identityDigest: link.identityDigest,
    epochManifestRevision: link.epochManifestRevision,
    epochManifestChecksumSha256: link.epochManifestChecksumSha256,
  }) + "\n";
}

function materialDirectory(homeDir: string): string {
  const directory = activationArtifactDirectory(homeDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

/** Place raw bytes at the link path for this generation (mode 0600), as a
 * stored-record fixture that bypasses the writer's validation. */
function placeRawLink(homeDir: string, generationId: string, content: string): string {
  materialDirectory(homeDir);
  const path = activationGenerationLinkPath(homeDir, generationId);
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}

describe("recordActivationGenerationLink", () => {
  it("durably writes a fresh link named by the generation id's sha256 and returns outcome written", () => {
    const homeDir = home();
    const result = recordActivationGenerationLink({ homeDir, ...linkInput() });
    expect(result.outcome).toBe("written");
    expect(result.link).toEqual(expectedLink());
    expect(result.path).toBe(join(activationArtifactDirectory(homeDir), "generation-" + sha256(GENERATION) + ".link"));
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
    expect(readFileSync(result.path, "utf8")).toBe(wireBytes(expectedLink()));
  });

  it("reuses a byte-identical existing link (idempotent retry after a crash)", () => {
    const homeDir = home();
    recordActivationGenerationLink({ homeDir, ...linkInput() });
    const retry = recordActivationGenerationLink({ homeDir, ...linkInput() });
    expect(retry.outcome).toBe("reused");
    expect(retry.link).toEqual(expectedLink());
  });

  it("refuses with a typed conflict when the same generation is linked to a different publicationId", () => {
    const homeDir = home();
    recordActivationGenerationLink({ homeDir, ...linkInput() });
    expect(() => recordActivationGenerationLink({ homeDir, ...linkInput({ publicationId: "pub-2" }) })).toThrow(
      ActivationGenerationLinkConflictError,
    );
    // The original is never overwritten.
    expect(readFileSync(activationGenerationLinkPath(homeDir, GENERATION), "utf8")).toBe(wireBytes(expectedLink()));
  });

  it("refuses with a typed conflict when the same generation is linked to a different identity digest", () => {
    const homeDir = home();
    recordActivationGenerationLink({ homeDir, ...linkInput() });
    expect(() => recordActivationGenerationLink({ homeDir, ...linkInput({ identityDigest: DIGEST_B }) })).toThrow(
      ActivationGenerationLinkConflictError,
    );
  });

  it.each([
    ["epochManifestRevision", { epochManifestRevision: 6 }],
    ["epochManifestChecksumSha256", { epochManifestChecksumSha256: DIGEST_B }],
  ] as const)("refuses with a typed conflict when a retry carries a different frozen %s (A8: the pair is read from the link, never re-derived)", (_name, overrides) => {
    const homeDir = home();
    recordActivationGenerationLink({ homeDir, ...linkInput() });
    expect(() => recordActivationGenerationLink({ homeDir, ...linkInput(overrides) })).toThrow(
      ActivationGenerationLinkConflictError,
    );
  });

  it("accepts the genesis revision 0 as a frozen epoch manifest revision", () => {
    const homeDir = home();
    const result = recordActivationGenerationLink({ homeDir, ...linkInput({ epochManifestRevision: 0 }) });
    expect(result.link.epochManifestRevision).toBe(0);
  });

  it("keeps links for different generations side by side", () => {
    const homeDir = home();
    recordActivationGenerationLink({ homeDir, ...linkInput() });
    const other = recordActivationGenerationLink({ homeDir, ...linkInput({ generationId: "generation-2", publicationId: "pub-2" }) });
    expect(other.outcome).toBe("written");
    expect(readActivationGenerationLink({ homeDir, generationId: GENERATION })).toMatchObject({
      state: "resolved", link: expectedLink(),
    });
    expect(readActivationGenerationLink({ homeDir, generationId: "generation-2" })).toMatchObject({
      state: "resolved", link: expectedLink({ generationId: "generation-2", publicationId: "pub-2" }),
    });
  });

  it("fails closed when the private LCM root does not exist", () => {
    expect(() => recordActivationGenerationLink({ homeDir: homeWithoutLcmRoot(), ...linkInput() })).toThrow(
      ActivationArtifactUnsafeStorageError,
    );
  });

  it.each([
    ["non-record input", null],
    ["extra key", { ...linkInput(), extra: true }],
    ["missing identityDigest", { generationId: GENERATION, publicationId: "pub-1" }],
    ["non-string homeDir", { homeDir: 7, ...linkInput() }],
    ["invalid generationId", linkInput({ generationId: "-bad" })],
    ["invalid publicationId", linkInput({ publicationId: "bad/id" })],
    ["invalid identityDigest", linkInput({ identityDigest: "A".repeat(64) })],
    ["missing epoch manifest pair", { generationId: GENERATION, publicationId: "pub-1", identityDigest: DIGEST_A }],
    ["negative epochManifestRevision", linkInput({ epochManifestRevision: -1 })],
    ["fractional epochManifestRevision", linkInput({ epochManifestRevision: 1.5 })],
    ["string epochManifestRevision", linkInput({ epochManifestRevision: "5" as unknown as number })],
    ["invalid epochManifestChecksumSha256", linkInput({ epochManifestChecksumSha256: "abc" })],
  ])("rejects %s before any I/O", (_name, input) => {
    const homeDir = home();
    expect(() => recordActivationGenerationLink(
      (input === null ? null : { homeDir, ...input }) as unknown as Parameters<typeof recordActivationGenerationLink>[0],
    )).toThrow(ActivationArtifactValidationError);
    expect(existsSync(activationArtifactDirectory(homeDir))).toBe(false);
  });

  it("is unresolvable (throws), not a fresh write, when the existing link's permission is genuinely denied", () => {
    const homeDir = home();
    const first = recordActivationGenerationLink({ homeDir, ...linkInput() });
    chmodSync(first.path, 0o000);
    try {
      expect(() => recordActivationGenerationLink({ homeDir, ...linkInput() })).toThrow(
        ActivationArtifactPresenceUnresolvableError,
      );
    } finally {
      chmodSync(first.path, 0o600);
    }
  });
});

/** Rebuild the exact post-link crash state atomicWritePrivateFileDurable's
 * requireAbsent path leaves when linkSync(final) succeeds but the scratch
 * unlink never runs: the final name and its scratch twin, both nlink=2. */
function buildLinkCrashTwin(homeDir: string, content: string): Readonly<{ finalPath: string; scratchPath: string }> {
  const directory = materialDirectory(homeDir);
  const finalPath = activationGenerationLinkPath(homeDir, GENERATION);
  const scratchPath = join(
    directory,
    "." + "generation-" + sha256(GENERATION) + ".link." + randomBytes(12).toString("hex") + ".tmp",
  );
  writeFileSync(scratchPath, content, { mode: 0o600 });
  linkSync(scratchPath, finalPath);
  return { finalPath, scratchPath };
}

describe("recordActivationGenerationLink: post-link crash-twin recovery (shared with the artifact record)", () => {
  it("converges on retry after the exact post-link crash state, completing the interrupted unlink", () => {
    const homeDir = home();
    const { finalPath, scratchPath } = buildLinkCrashTwin(homeDir, wireBytes(expectedLink()));
    expect(statSync(finalPath).nlink).toBe(2);
    const result = recordActivationGenerationLink({ homeDir, ...linkInput() });
    expect(result.outcome).toBe("reused");
    expect(statSync(finalPath).nlink).toBe(1);
    expect(existsSync(scratchPath)).toBe(false);
  });

  it("refuses with the link's own typed conflict when the authenticated twin's content differs", () => {
    const homeDir = home();
    buildLinkCrashTwin(homeDir, wireBytes(expectedLink({ publicationId: "pub-2" })));
    expect(() => recordActivationGenerationLink({ homeDir, ...linkInput() })).toThrow(ActivationGenerationLinkConflictError);
  });

  it("is unresolvable when nlink=2 has no matching writer-scratch twin", () => {
    const homeDir = home();
    const directory = materialDirectory(homeDir);
    const unrelated = join(directory, "unrelated-hardlink-name");
    writeFileSync(unrelated, "not a writer scratch file", { mode: 0o600 });
    linkSync(unrelated, activationGenerationLinkPath(homeDir, GENERATION));
    expect(() => recordActivationGenerationLink({ homeDir, ...linkInput() })).toThrow(
      ActivationArtifactPresenceUnresolvableError,
    );
  });
});

describe("readActivationGenerationLink: three-valued", () => {
  it("resolves a recorded link exactly", () => {
    const homeDir = home();
    const recorded = recordActivationGenerationLink({ homeDir, ...linkInput() });
    expect(readActivationGenerationLink({ homeDir, generationId: GENERATION })).toEqual({
      state: "resolved", link: expectedLink(), path: recorded.path,
    });
  });

  it("is authoritatively absent when the private LCM root does not exist", () => {
    const result = readActivationGenerationLink({ homeDir: homeWithoutLcmRoot(), generationId: GENERATION });
    expect(result).toMatchObject({ state: "authoritatively-absent" });
    expect((result as { detail: string }).detail).toContain("private LCM root");
  });

  it("is authoritatively absent when the artifact directory does not exist", () => {
    const result = readActivationGenerationLink({ homeDir: home(), generationId: GENERATION });
    expect(result).toMatchObject({ state: "authoritatively-absent" });
    expect((result as { detail: string }).detail).toContain("artifact directory");
  });

  it("is authoritatively absent when the directory exists but holds no link for this generation", () => {
    const homeDir = home();
    recordActivationGenerationLink({ homeDir, ...linkInput({ generationId: "generation-2" }) });
    const result = readActivationGenerationLink({ homeDir, generationId: GENERATION });
    expect(result).toMatchObject({ state: "authoritatively-absent" });
    expect((result as { detail: string }).detail).toContain("no activation generation link exists");
  });

  it("is unresolvable (root-unauthenticated), never absent, when the private root exists with an untrusted mode", () => {
    const homeDir = home();
    recordActivationGenerationLink({ homeDir, ...linkInput() });
    chmodSync(join(homeDir, ".lcm"), 0o755);
    expect(readActivationGenerationLink({ homeDir, generationId: GENERATION })).toMatchObject({
      state: "unresolvable", reason: "root-unauthenticated",
    });
  });

  it("is unresolvable (directory-unauthenticated), never absent, when the artifact directory has an untrusted mode", () => {
    const homeDir = home();
    recordActivationGenerationLink({ homeDir, ...linkInput() });
    chmodSync(activationArtifactDirectory(homeDir), 0o755);
    expect(readActivationGenerationLink({ homeDir, generationId: GENERATION })).toMatchObject({
      state: "unresolvable", reason: "directory-unauthenticated",
    });
  });

  it("is unresolvable (read-unresolvable), never absent, when the link's permission is genuinely denied", () => {
    const homeDir = home();
    const recorded = recordActivationGenerationLink({ homeDir, ...linkInput() });
    chmodSync(recorded.path, 0o000);
    try {
      expect(readActivationGenerationLink({ homeDir, generationId: GENERATION })).toMatchObject({
        state: "unresolvable", reason: "read-unresolvable",
      });
    } finally {
      chmodSync(recorded.path, 0o600);
    }
  });

  it("is unresolvable (multi-link) for an unconverged post-link crash twin; reads never repair it", () => {
    const homeDir = home();
    buildLinkCrashTwin(homeDir, wireBytes(expectedLink()));
    expect(readActivationGenerationLink({ homeDir, generationId: GENERATION })).toMatchObject({
      state: "unresolvable", reason: "multi-link",
    });
  });

  it.each([
    ["not JSON", "{not json\n"],
    ["missing trailing newline (non-canonical)", wireBytes(expectedLink()).slice(0, -1)],
    ["non-canonical key order / whitespace", JSON.stringify(expectedLink(), null, 2) + "\n"],
    ["extra key", canonicalJson({ ...expectedLink(), extra: 1 }) + "\n"],
    ["missing key", canonicalJson({ version: 1, generationId: GENERATION, publicationId: "pub-1", identityDigest: DIGEST_A }) + "\n"],
    ["missing epoch manifest pair (pre-A8 shape)", canonicalJson({ version: 1, generationId: GENERATION, publicationId: "pub-1", identityDigest: DIGEST_A }) + "\n"],
    ["negative epochManifestRevision", canonicalJson({ ...expectedLink(), epochManifestRevision: -1 }) + "\n"],
    ["invalid epochManifestChecksumSha256 pattern", canonicalJson({ ...expectedLink(), epochManifestChecksumSha256: "zz" }) + "\n"],
    ["unsupported version", canonicalJson({ ...expectedLink(), version: 2 }) + "\n"],
    ["invalid generationId pattern", canonicalJson({ ...expectedLink(), generationId: "-bad" }) + "\n"],
    ["invalid publicationId pattern", canonicalJson({ ...expectedLink(), publicationId: "bad/id" }) + "\n"],
    ["invalid identityDigest pattern", canonicalJson({ ...expectedLink(), identityDigest: "A".repeat(64) }) + "\n"],
    ["array body", "[]\n"],
  ])("is unresolvable (malformed-record), never resolved, for a stored record that is %s", (_name, content) => {
    const homeDir = home();
    placeRawLink(homeDir, GENERATION, content);
    expect(readActivationGenerationLink({ homeDir, generationId: GENERATION })).toMatchObject({
      state: "unresolvable", reason: "malformed-record",
    });
  });

  it("is unresolvable (generation-mismatch) when a valid record at this generation's path names another generation", () => {
    const homeDir = home();
    placeRawLink(homeDir, GENERATION, wireBytes(expectedLink({ generationId: "generation-2" })));
    const result = readActivationGenerationLink({ homeDir, generationId: GENERATION });
    expect(result).toMatchObject({ state: "unresolvable", reason: "generation-mismatch" });
    expect((result as { detail: string }).detail).toContain("generation-2");
  });

  it("is unresolvable (directory-changed) when the artifact directory stops authenticating during the read", () => {
    const homeDir = home();
    recordActivationGenerationLink({ homeDir, ...linkInput() });
    const directory = activationArtifactDirectory(homeDir);
    const readWithStat: typeof readBoundedRegularFileWithStat = (path, options) => {
      const value = readBoundedRegularFileWithStat(path, options);
      chmodSync(directory, 0o755);
      return value;
    };
    expect(readActivationGenerationLink({ homeDir, generationId: GENERATION }, { readWithStat })).toMatchObject({
      state: "unresolvable", reason: "directory-changed",
    });
  });

  it("propagates an unrecognized read failure raw rather than attributing it", () => {
    const homeDir = home();
    recordActivationGenerationLink({ homeDir, ...linkInput() });
    const readWithStat: typeof readBoundedRegularFileWithStat = () => { throw new Error("disk on fire"); };
    expect(() => readActivationGenerationLink({ homeDir, generationId: GENERATION }, { readWithStat })).toThrow("disk on fire");
  });

  it.each([
    ["invalid generationId", { homeDir: "/nonexistent", generationId: "-bad" }],
    ["non-record input", null],
  ])("rejects %s before any I/O", (_name, input) => {
    expect(() => readActivationGenerationLink(
      input as unknown as Parameters<typeof readActivationGenerationLink>[0],
    )).toThrow(ActivationArtifactValidationError);
  });
});

