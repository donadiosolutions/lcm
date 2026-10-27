import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installConnector, probeCodexCliVersion, type CodexCliRunRequest } from "../../src/connectors/installer.js";
import { CODEX_TRUST_NOTICE, codexLcmHooks } from "../../src/connectors/codex-hooks.js";

const lcm = (command: string) => ({ type: "command", command });
const DUPLICATE_ROLES = JSON.stringify({
  hooks: { Stop: [{ hooks: [lcm("lcm session-snapshot --client codex"), lcm("lcm session-snapshot --client codex")] }] },
}, null, 2) + "\n";

describe("Codex connector install preserves Codex per-hook choices", () => {
  let home: string;
  let originalHome: string | undefined;
  let hooksPath: string;
  let configPath: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "lcm-codex-readiness-"));
    originalHome = process.env.HOME;
    process.env.HOME = home;
    mkdirSync(join(home, ".codex"));
    hooksPath = join(home, ".codex", "hooks.json");
    configPath = join(home, ".codex", "config.toml");
  });
  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true });
  });

  const bundle = () => installConnector("codex", "cli", home, { persistTransport: false, codexMcpRunner: { get: () => [] } });

  it("refuses an ambiguous hooks file on every install path before writing anything", () => {
    writeFileSync(hooksPath, DUPLICATE_ROLES);
    writeFileSync(configPath, "model = 'x'\n");
    for (const attempt of [
      () => installConnector("codex", "hook", home),
      () => installConnector("codex", undefined as never, home),
      bundle,
    ]) {
      expect(attempt).toThrow("multiple LCM handlers share one role");
      expect(readFileSync(hooksPath, "utf-8")).toBe(DUPLICATE_ROLES);
      expect(readFileSync(configPath, "utf-8")).toBe("model = 'x'\n");
    }
    expect(existsSync(join(home, ".lcm", "config.json"))).toBe(false);
  });

  it("refuses a malformed or repeated-key hooks file on every install path before writing anything", () => {
    const original = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo mine"}]}],}}';
    const cases: Array<[string, string, string]> = [
      ["a trailing comma (#1586)", original, "is not valid JSON"],
      ["trailing literal backslash-n text (#1606)", '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo mine"}]}]}}' + "\\n", "is not valid JSON"],
      ["a repeated key", '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo mine"}]}]},"hooks":{}}', 'repeats the key "hooks"'],
    ];
    for (const [name, content, reason] of cases) {
      writeFileSync(hooksPath, content);
      writeFileSync(configPath, "model = 'x'\n");
      for (const attempt of [
        () => installConnector("codex", "hook", home),
        () => installConnector("codex", undefined as never, home),
        bundle,
      ]) {
        expect(attempt, name).toThrow(reason);
        expect(readFileSync(hooksPath, "utf-8"), name).toBe(content);
        expect(readFileSync(configPath, "utf-8"), name).toBe("model = 'x'\n");
      }
    }
    expect(existsSync(join(home, ".lcm", "config.json"))).toBe(false);
  });

  it("keeps LCM handlers in their slots and never touches Codex hook state", () => {
    const state = '\n[hooks.state."' + hooksPath + ':session_start:0:1"]\nenabled = false\ntrusted_hash = "sha256:user"\n';
    const config = "[features]\nhooks = true\n" + state;
    writeFileSync(configPath, config);
    writeFileSync(hooksPath, JSON.stringify({
      hooks: { SessionStart: [
        { hooks: [{ type: "command", command: "echo honcho" }] },
        { matcher: "startup|resume|clear", hooks: [lcm("lcm restore --client codex")] },
        { hooks: [{ type: "command", command: "echo reaper" }] },
      ] },
    }));
    for (let round = 0; round < 2; round++) {
      expect(bundle().success).toBe(true);
      const installed = JSON.parse(readFileSync(hooksPath, "utf-8")).hooks;
      expect(installed.SessionStart.map((group: any) => group.hooks[0].command)).toEqual([
        "echo honcho", "lcm restore --client codex", "echo reaper",
      ]);
      expect(installed.SessionStart[1]).toEqual(codexLcmHooks().SessionStart[0]);
      expect(installed.Stop).toEqual(codexLcmHooks().Stop);
      expect(readFileSync(configPath, "utf-8")).toBe(config);
    }
  });

  it("leaves a deliberately disabled feature unchanged and reports it with the trust step", () => {
    writeFileSync(configPath, "[features]\nhooks = false\ncodex_hooks = true\n");
    const disabledNotice = "Codex hooks feature is disabled in config.toml; left unchanged; LCM hooks will not run until you enable it";
    for (const result of [installConnector("codex", "hook", home), bundle(), installConnector("codex", undefined as never, home)]) {
      expect(result.success).toBe(true);
      expect(result.notices).toEqual([disabledNotice, CODEX_TRUST_NOTICE]);
      expect(readFileSync(configPath, "utf-8")).toBe("[features]\nhooks = false\ncodex_hooks = true\n");
    }
    expect(JSON.parse(readFileSync(hooksPath, "utf-8")).hooks.Stop).toEqual(codexLcmHooks().Stop);
  });

  it("adds the feature only when absent and always reports the trust step", () => {
    const result = installConnector("codex", "hook", home);
    expect(readFileSync(configPath, "utf-8")).toBe("[features]\nhooks = true\n");
    expect(result.notices).toEqual([CODEX_TRUST_NOTICE]);
    expect(installConnector("codex", "rules", home).notices).toBeUndefined();
  });
});

describe("probeCodexCliVersion", () => {
  let originalPath: string | undefined;
  let originalLang: string | undefined;
  let empty: string;
  beforeEach(() => {
    originalPath = process.env.PATH;
    originalLang = process.env.LANG;
    empty = mkdtempSync(join(tmpdir(), "lcm-no-codex-"));
  });
  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalLang === undefined) delete process.env.LANG;
    else process.env.LANG = originalLang;
    rmSync(empty, { recursive: true });
  });

  it("runs codex --version with a minimal environment and a bounded request", () => {
    const requests: CodexCliRunRequest[] = [];
    const run = (request: CodexCliRunRequest) => {
      requests.push(request);
      return { status: 0, stdout: Buffer.from("codex-cli 0.163.0\nextra\n") };
    };
    const dependencies = { environment: { PATH: "/fixture/bin", HOME: "/h", LANG: "C", SECRET: "x" }, getUid: () => undefined };
    expect(probeCodexCliVersion("/work", run, dependencies)).toEqual({ state: "found", raw: "codex-cli 0.163.0" });
    expect(requests).toEqual([{
      executable: "codex",
      argv: ["--version"],
      cwd: "/work",
      env: { PATH: "/fixture/bin", HOME: "/h", LANG: "C" },
      shell: false,
      timeout: 5000,
      maxBuffer: 1_048_576,
    }]);
    probeCodexCliVersion("/work", (request) => {
      expect(request.env).toEqual({ PATH: "/fixture/bin" });
      return { status: 0, stdout: "codex-cli 0.163.0" };
    }, { environment: { PATH: "/fixture/bin" }, getUid: () => undefined });
  });

  it("forwards only the validated session-bus variables for wrapper-launched codex builds", () => {
    const runtime = "/run/user/1000";
    const environment = { PATH: "/p", HOME: "/h", XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: "unix:path=" + runtime + "/bus", OTHER: "no" };
    const lstat = (path: string) => ({
      uid: 1000,
      mode: path === runtime ? 0o40700 : 0o140600,
      isDirectory: () => path === runtime,
      isSocket: () => path !== runtime,
      isSymbolicLink: () => false,
    });
    const envFor = (dependencies: Parameters<typeof probeCodexCliVersion>[2]) => {
      let seen: NodeJS.ProcessEnv = {};
      probeCodexCliVersion("/work", (request) => {
        seen = request.env;
        return { status: 0, stdout: "codex-cli 0.163.0" };
      }, dependencies);
      return seen;
    };
    expect(envFor({ environment, getUid: () => 1000, lstat, realpath: (path) => path })).toEqual({
      PATH: "/p", HOME: "/h", XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: "unix:path=" + runtime + "/bus",
    });
    // A foreign-owned or redirected runtime directory is not forwarded.
    expect(envFor({ environment, getUid: () => 1001, lstat, realpath: (path) => path })).toEqual({ PATH: "/p", HOME: "/h" });
    expect(envFor({ environment, getUid: () => 1000, lstat, realpath: () => "/elsewhere" })).toEqual({ PATH: "/p", HOME: "/h" });
  });

  it("reports short static reasons when the version cannot be read", () => {
    const run = (result: ReturnType<Parameters<typeof probeCodexCliVersion>[1] & {}>) => probeCodexCliVersion("/work", () => result);
    expect(run({ status: 0, stdout: "  \n" })).toEqual({ state: "unavailable", reason: "codex --version printed nothing" });
    expect(run({ status: 0 })).toEqual({ state: "unavailable", reason: "codex --version printed nothing" });
    expect(run({ status: 2, stderr: "secret" })).toEqual({ state: "unavailable", reason: "codex --version exited with an error" });
    expect(run({ status: null, error: Object.assign(new Error("secret /path"), { code: "ENOENT" }) }))
      .toEqual({ state: "unavailable", reason: "codex not found on PATH" });
    expect(run({ status: null, error: new Error("secret /path") }))
      .toEqual({ state: "unavailable", reason: "codex --version could not be run" });
    expect(probeCodexCliVersion("/work", () => { throw new Error("secret /path"); }))
      .toEqual({ state: "unavailable", reason: "codex --version could not be run" });
  });

  it("uses the real runner and reports a missing codex binary", () => {
    process.env.PATH = empty;
    expect(probeCodexCliVersion(empty)).toEqual({ state: "unavailable", reason: "codex not found on PATH" });
    expect(probeCodexCliVersion()).toEqual({ state: "unavailable", reason: "codex not found on PATH" });
  });
});
