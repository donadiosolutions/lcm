import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearConnectorTransport,
  readConnectorTransport,
  readConnectorTransportSnapshot,
  setConnectorTransport,
} from "../../src/config-manager.js";
import { PrivateMutationLockContentionError } from "../../src/private-mutation-lock.js";
import { withBackendPublicationConfigLockAsync } from "../../src/storage/backend-publication.js";

const temporaryDirectories: string[] = [];

function makeHome(content?: unknown): { readonly home: string; readonly configPath: string } {
  const home = mkdtempSync(join(tmpdir(), "lcm-transport-config-contract-"));
  temporaryDirectories.push(home);
  const root = join(home, ".lcm");
  mkdirSync(root, { mode: 0o700 });
  const configPath = join(root, "config.json");
  if (content !== undefined) writeFileSync(configPath, `${JSON.stringify(content)}\n`, { mode: 0o600 });
  return { home, configPath };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("persisted connector transport configuration", () => {
  it("keeps both agents when public locked setters update different choices", () => {
    const { configPath } = makeHome({ version: 1, unrelated: { keep: true } });

    setConnectorTransport(configPath, "codex", "cli");
    setConnectorTransport(configPath, "claude-code", "mcp");

    expect(readConnectorTransport(configPath, "codex")).toBe("cli");
    expect(readConnectorTransport(configPath, "claude-code")).toBe("mcp");
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      version: 1,
      unrelated: { keep: true },
      connectors: { transports: { codex: "cli", "claude-code": "mcp" } },
    });
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it("does not create a missing config for reads or absent clears", () => {
    const { configPath } = makeHome();

    expect(readConnectorTransport(configPath, "codex")).toBeUndefined();
    expect(readConnectorTransportSnapshot(configPath, "codex")).toBeUndefined();
    expect(clearConnectorTransport(configPath, "codex")).toBe(false);
    expect(existsSync(configPath)).toBe(false);
  });

  it("reads a stable connector snapshot while the publication lock is held", async () => {
    const { configPath } = makeHome({
      version: 1,
      connectors: { transports: { codex: "mcp" } },
    });

    await withBackendPublicationConfigLockAsync(configPath, async () => {
      expect(readConnectorTransportSnapshot(configPath, "codex")).toBe("mcp");
    });
  });

  it("reads the public transport accessor while the publication lock is held", async () => {
    const { configPath } = makeHome({
      version: 1,
      connectors: { transports: { codex: "mcp" } },
    });

    await withBackendPublicationConfigLockAsync(configPath, async () => {
      expect(readConnectorTransport(configPath, "codex")).toBe("mcp");
    });
  });

  it("keeps transport mutations serialized while the publication lock is held", async () => {
    const { configPath } = makeHome({ version: 1 });

    await withBackendPublicationConfigLockAsync(configPath, async () => {
      expect(() => setConnectorTransport(configPath, "codex", "cli"))
        .toThrow(PrivateMutationLockContentionError);
      expect(readConnectorTransportSnapshot(configPath, "codex")).toBeUndefined();
    });
    expect(readConnectorTransport(configPath, "codex")).toBeUndefined();
  });

  it("rejects connector config drift between lock-free snapshots", () => {
    const { configPath } = makeHome({
      version: 1,
      connectors: { transports: { codex: "mcp" } },
    });

    expect(() => readConnectorTransportSnapshot(configPath, "codex", {
      _afterFirstSnapshotForTesting: () => {
        writeFileSync(configPath, JSON.stringify({ version: 1 }), { mode: 0o600 });
      },
    })).toThrow("Configuration changed during lock-free connector transport inspection");
  });

  it("rejects publication evidence that changes between snapshots", () => {
    const { home, configPath } = makeHome({
      version: 1,
      connectors: { transports: { codex: "mcp" } },
    });
    const publicationDir = join(home, ".lcm", "backend-publication");
    mkdirSync(publicationDir, { recursive: true, mode: 0o700 });

    expect(() => readConnectorTransportSnapshot(configPath, "codex", {
      _afterFirstSnapshotForTesting: () => {
        writeFileSync(join(publicationDir, "journal.json"), "{", { mode: 0o600 });
      },
    })).toThrow("backend publication evidence is incomplete");
  });

  it("propagates non-absence failures from the initial connector snapshot probe", () => {
    expect(() => readConnectorTransportSnapshot("\0", "codex")).toThrow();
  });

  it("creates a missing config only when a transport is explicitly set", () => {
    const { configPath } = makeHome();

    setConnectorTransport(configPath, "codex", "cli");

    expect(readConnectorTransport(configPath, "codex")).toBe("cli");
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it("clears one choice, prunes empty containers, and is idempotent", () => {
    const { configPath } = makeHome({
      version: 1,
      unrelated: { keep: true },
      connectors: { transports: { codex: "cli", cursor: "mcp" }, other: true },
    });

    expect(clearConnectorTransport(configPath, "codex")).toBe(true);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      version: 1,
      unrelated: { keep: true },
      connectors: { transports: { cursor: "mcp" }, other: true },
    });
    expect(clearConnectorTransport(configPath, "codex")).toBe(false);

    expect(clearConnectorTransport(configPath, "cursor")).toBe(true);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      version: 1,
      unrelated: { keep: true },
      connectors: { other: true },
    });
  });

  it("prunes connectors when its final transport and unrelated key are removed", () => {
    const { configPath } = makeHome({ version: 1, connectors: { transports: { codex: "cli" } } });

    expect(clearConnectorTransport(configPath, "codex")).toBe(true);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ version: 1 });
  });

  it("treats a connectors object without stored transports as an absent choice", () => {
    const { configPath } = makeHome({ version: 1, connectors: { other: true } });

    expect(clearConnectorTransport(configPath, "codex")).toBe(false);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      version: 1,
      connectors: { other: true },
    });
  });

  it.each([
    ["malformed JSON", "{"],
    ["non-object connectors", JSON.stringify({ connectors: [] })],
    ["non-object transports", JSON.stringify({ connectors: { transports: [] } })],
    ["invalid value", JSON.stringify({ connectors: { transports: { codex: "invalid" } } })],
    ["invalid value in another agent", JSON.stringify({ connectors: { transports: { cursor: "invalid" } } })],
  ])("fails closed for %s", (_label, content) => {
    const { configPath } = makeHome();
    writeFileSync(configPath, content, { mode: 0o600 });

    expect(() => readConnectorTransport(configPath, "codex")).toThrow();
    expect(() => clearConnectorTransport(configPath, "codex")).toThrow();
    expect(() => setConnectorTransport(configPath, "codex", "cli")).toThrow();
  });

  it("rejects an invalid runtime transport before changing the file", () => {
    const { configPath } = makeHome({ version: 1 });
    const before = readFileSync(configPath, "utf8");

    expect(() => setConnectorTransport(configPath, "codex", "invalid" as never)).toThrow(/one of/);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it.each([
    ["symlink", (configPath: string) => {
      const target = `${configPath}.target`;
      writeFileSync(target, JSON.stringify({ version: 1 }), { mode: 0o600 });
      rmSync(configPath);
      symlinkSync(target, configPath);
    }],
    ["directory", (configPath: string) => {
      rmSync(configPath);
      mkdirSync(configPath, { mode: 0o700 });
    }],
    ["unsafe mode", (configPath: string) => chmodSync(configPath, 0o644)],
    ["oversized", (configPath: string) => writeFileSync(configPath, `{"padding":"${"x".repeat(4 * 1024 * 1024)}"}`, { mode: 0o600 })],
  ] as const)("rejects %s config inputs", (_label, mutate) => {
    const { configPath } = makeHome({ version: 1 });
    mutate(configPath);

    expect(() => readConnectorTransport(configPath, "codex")).toThrow();
    expect(() => readConnectorTransportSnapshot(configPath, "codex")).toThrow();
    expect(() => clearConnectorTransport(configPath, "codex")).toThrow();
    expect(() => setConnectorTransport(configPath, "codex", "cli")).toThrow();
  });

  it("uses an atomic owner-only replacement while preserving the original inode on failure", () => {
    const { configPath } = makeHome({ version: 1 });
    const before = lstatSync(configPath);

    setConnectorTransport(configPath, "codex", "cli");

    const after = lstatSync(configPath);
    expect(after.ino).not.toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o600);
  });
});
