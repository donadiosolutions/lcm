import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { removeManagedClaudeSettings } from "../src/installer/settings.js";
import {
  legacyLaunchdPlistName,
  legacyLcmSlug,
  legacySystemdServiceName,
} from "../src/legacy-names.js";

export function removeClaudeSettings(existing: any): any {
  return removeManagedClaudeSettings(existing);
}

export interface TeardownDeps {
  spawnSync: (cmd: string, args: string[], opts?: any) => SpawnSyncReturns<string>;
  existsSync: (path: string) => boolean;
  rmSync: (path: string, options?: { recursive?: boolean; force?: boolean }) => void;
  readFileSync: (path: string, encoding: string) => string;
  writeFileSync: (path: string, data: string) => void;
}

const defaultDeps: TeardownDeps = {
  spawnSync: spawnSync as any,
  existsSync,
  rmSync,
  readFileSync: readFileSync as any,
  writeFileSync,
};

export function teardownDaemonService(deps: TeardownDeps = defaultDeps): void {
  const platform = process.platform;

  if (platform === "darwin") {
    const plistPath = join(
      homedir(),
      "Library",
      "LaunchAgents",
      legacyLaunchdPlistName()
    );
    if (deps.existsSync(plistPath)) {
      console.log("Stopping daemon service (launchd)...");
      deps.spawnSync("launchctl", ["unload", plistPath], { stdio: "inherit" });
      deps.rmSync(plistPath);
      console.log(`Removed ${plistPath}`);
    } else {
      console.warn("Warning: launchd plist not found, skipping unload.");
    }
  } else if (platform === "linux") {
    const unitPath = join(
      homedir(),
      ".config",
      "systemd",
      "user",
      legacySystemdServiceName()
    );
    console.log("Stopping daemon service (systemd)...");
    const legacyServiceName = legacyLcmSlug();
    deps.spawnSync("systemctl", ["--user", "stop", legacyServiceName], { stdio: "inherit" });
    deps.spawnSync("systemctl", ["--user", "disable", legacyServiceName], { stdio: "inherit" });
    if (deps.existsSync(unitPath)) {
      deps.rmSync(unitPath);
      console.log(`Removed ${unitPath}`);
    } else {
      console.warn("Warning: systemd unit file not found, skipping removal.");
    }
    deps.spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
  } else {
    console.warn(`Warning: Unsupported platform "${platform}". Skipping daemon service teardown.`);
  }
}

export async function uninstall(deps: TeardownDeps = defaultDeps): Promise<void> {
  // Validate and remove runtime-facing Claude settings before deleting the
  // daemon or packaged assets. A malformed/unwritable settings file must leave
  // the installation intact rather than creating dangling active hooks.
  const settingsPath = join(homedir(), ".claude", "settings.json");
  if (deps.existsSync(settingsPath)) {
    try {
      const existing = JSON.parse(deps.readFileSync(settingsPath, "utf-8"));
      deps.writeFileSync(settingsPath, JSON.stringify(removeClaudeSettings(existing), null, 2));
      console.log(`Removed lcm from ${settingsPath}`);
    } catch (err) {
      throw new Error(
        `Could not update ${settingsPath}; uninstall was stopped before removing runtime assets: `
        + `${err instanceof Error ? err.message : err}`,
      );
    }
  }

  teardownDaemonService(deps);

  const claudeHome = join(homedir(), ".claude");
  const commandNames = [
    "lcm-compact.md", "lcm-curate.md", "lcm-diagnose.md", "lcm-doctor.md",
    "lcm-import.md", "lcm-promote.md", "lcm-sensitive.md", "lcm-stats.md",
    "lcm-status.md",
  ];
  for (const name of commandNames) {
    const path = join(claudeHome, "commands", name);
    if (deps.existsSync(path)) deps.rmSync(path, { force: true });
  }
  const skillPath = join(claudeHome, "skills", "lcm-context");
  if (deps.existsSync(skillPath)) deps.rmSync(skillPath, { recursive: true, force: true });
  const lcmMdPath = join(claudeHome, "lcm.md");
  if (deps.existsSync(lcmMdPath)) deps.rmSync(lcmMdPath, { force: true });

  const claudeMdPath = join(claudeHome, "CLAUDE.md");
  if (deps.existsSync(claudeMdPath)) {
    try {
      const existing = deps.readFileSync(claudeMdPath, "utf-8");
      const updated = existing
        .replace(/^[ \t]*<!--\s*lcm:start\s*-->[\s\S]*?^[ \t]*<!--\s*lcm:end\s*-->[ \t]*(?:\r?\n)?/m, "")
        .trimEnd();
      if (updated !== existing.trimEnd()) deps.writeFileSync(claudeMdPath, updated ? `${updated}\n` : "");
    } catch (err) {
      console.warn(`Warning: could not update ${claudeMdPath}: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log("lcm uninstalled.");
}
