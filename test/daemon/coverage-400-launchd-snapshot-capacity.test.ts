import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const EXPECTED_SNAPSHOT_CAPACITY = 16;

function createCredentialContext(index: number): {
  root: string;
  file: string;
  env: Record<string, string>;
} {
  const root = mkdtempSync(join(tmpdir(), `lcm-launchd-snapshot-capacity-${index}-`));
  const directory = join(root, "credentials");
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
  const file = join(directory, "OPENAI_API_KEY");
  writeFileSync(file, `secret-${index}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return {
    root,
    file,
    env: {
      LCM_CREDENTIAL_DIRECTORY: directory,
      LCM_CREDENTIAL_OPENAI_API_KEY_FILE: file,
      OPENAI_API_KEY: "ambient-secret",
    },
  };
}

describe("Epic 400 launchd credential snapshot capacity", () => {
  it("fails closed at capacity without evicting or rereading an established context", async () => {
    // Use a fresh module instance so the boundary is deterministic and does
    // not depend on contexts created by other test files.
    vi.resetModules();
    const { resolveDaemonConfigEnv } = await import("../../src/daemon/config.js");
    const contexts = Array.from({ length: EXPECTED_SNAPSHOT_CAPACITY + 1 }, (_, index) => createCredentialContext(index));
    try {
      for (const [index, context] of contexts.slice(0, EXPECTED_SNAPSHOT_CAPACITY).entries()) {
        expect(resolveDaemonConfigEnv(context.env).OPENAI_API_KEY).toBe(`secret-${index}`);
        expect(existsSync(context.file)).toBe(false);
      }

      const established = contexts[0];
      const boundary = contexts[EXPECTED_SNAPSHOT_CAPACITY];
      expect(resolveDaemonConfigEnv(boundary.env).OPENAI_API_KEY).toBeUndefined();
      expect(existsSync(boundary.file)).toBe(true);

      writeFileSync(boundary.file, "replacement-secret\n", { mode: 0o600 });
      chmodSync(boundary.file, 0o600);
      expect(resolveDaemonConfigEnv(boundary.env).OPENAI_API_KEY).toBeUndefined();
      expect(existsSync(boundary.file)).toBe(true);
      expect(resolveDaemonConfigEnv(established.env).OPENAI_API_KEY).toBe("secret-0");
    } finally {
      for (const context of contexts) rmSync(context.root, { recursive: true, force: true });
    }
  });
});
