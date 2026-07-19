import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SUPPORTED_CHANNELS = new Set(["auto", "beta", "stable"]);

export function validateReleaseChannel(value) {
  if (!SUPPORTED_CHANNELS.has(value)) {
    throw new Error(
      `Unsupported release channel ${JSON.stringify(value)}; expected auto, beta, or stable`,
    );
  }
  return value;
}

export function validatePrereleaseState(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(".changeset/pre.json must contain a JSON object");
  }
  if (value.tag !== "beta") {
    throw new Error(
      `Unsupported Changesets prerelease tag ${JSON.stringify(value.tag)}; only beta is allowed`,
    );
  }
  if (value.mode !== "pre" && value.mode !== "exit") {
    throw new Error(
      `Unsupported Changesets prerelease mode ${JSON.stringify(value.mode)}; expected pre or exit`,
    );
  }
  return { mode: value.mode, tag: value.tag };
}

export function readPrereleaseState(
  path,
  { exists = existsSync, readFile = readFileSync } = {},
) {
  if (!exists(path)) return undefined;

  let value;
  try {
    value = JSON.parse(readFile(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read ${path}: ${message}`, { cause: error });
  }
  return validatePrereleaseState(value);
}

export function planPrereleaseTransition(channel, state) {
  validateReleaseChannel(channel);

  if (state !== undefined) validatePrereleaseState(state);

  if (channel === "auto") return [];

  if (channel === "beta") {
    if (state === undefined) return ["pre", "enter", "beta"];
    if (state.mode === "pre") return [];
    throw new Error(
      "Cannot re-enter beta while Changesets is exiting prerelease mode; finish the stable release first",
    );
  }

  if (state === undefined) {
    throw new Error("Cannot exit beta because Changesets prerelease mode is not active");
  }
  if (state.mode === "exit") return [];
  return ["pre", "exit"];
}

export function executeChecked(command, args, options, spawn = spawnSync) {
  const result = spawn(command, args, { ...options, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.signal) {
    throw new Error(
      `${command} ${args.join(" ")} was terminated by signal ${result.signal}; ` +
        "check system resource limits and retry",
    );
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with status ${result.status}`);
  }
}

export function runVersionPackages({
  channel = process.env.LCM_RELEASE_CHANNEL ?? "auto",
  cwd = process.cwd(),
  execute = executeChecked,
  exists = existsSync,
  readFile = readFileSync,
} = {}) {
  validateReleaseChannel(channel);

  const preStatePath = resolve(cwd, ".changeset/pre.json");
  const state = readPrereleaseState(preStatePath, { exists, readFile });
  const transition = planPrereleaseTransition(channel, state);
  const changesetCli = resolve(cwd, "node_modules/@changesets/cli/bin.js");

  if (transition.length > 0) {
    execute(process.execPath, [changesetCli, ...transition], { cwd });
  }
  execute(process.execPath, [changesetCli, "version"], { cwd });
  execute(process.execPath, [resolve(SCRIPT_DIR, "sync-plugin-version.mjs")], { cwd });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    runVersionPackages();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`version-packages: ${message}`);
    process.exitCode = 1;
  }
}
