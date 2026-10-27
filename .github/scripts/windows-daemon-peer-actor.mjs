import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [role, runId] = process.argv.slice(2);
if (!(["victim", "squatter"].includes(role) && /^[0-9]{1,20}$/.test(runId ?? ""))) {
  throw new Error("invalid Windows baseline actor arguments");
}

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(workspace, "dist", "lcm.mjs");
const profile = homedir();
const pidPath = join(profile, ".lcm", "daemon.pid");
const resultPath = join(profile, `lcm-peer-baseline-${runId}.json`);
const systemRoot = process.env.SystemRoot;
if (!systemRoot || !/^[A-Za-z]:\\Windows$/i.test(systemRoot)) {
  throw new Error("trusted Windows system root is unavailable");
}
const powerShell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const taskkill = join(systemRoot, "System32", "taskkill.exe");
if (!existsSync(powerShell) || !existsSync(taskkill)) {
  throw new Error("trusted Windows actor tools are unavailable");
}

const identity = spawnSync(powerShell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
  "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], {
  encoding: "utf8", timeout: 5_000, maxBuffer: 4_096, windowsHide: true,
});
const sid = identity.status === 0 ? identity.stdout.trim() : "";
if (!/^S-1-[0-9]+(?:-[0-9]+)+$/u.test(sid)) {
  throw new Error("actor token user SID is unavailable");
}

function diagnosticClass(stderr) {
  const text = String(stderr ?? "");
  for (const [name, pattern] of [
    ["uid-capability", /UID capability|process\.getuid/iu],
    ["descriptor-namespace", /descriptor namespace|\/proc\/self\/fd/iu],
    ["private-mode", /mode 0700|mode is not trusted|private directory/iu],
    ["filesystem", /\b(?:EACCES|EPERM|EINVAL|ENOENT|ENOTSUP)\b/iu],
    ["daemon-identity", /daemon (?:identity|endpoint|peer)/iu],
  ]) {
    if (pattern.test(text)) return name;
  }
  return text.length === 0 ? "none" : "other";
}

function boundedCli(args, timeoutMs = 20_000) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024,
    windowsHide: true,
    input: "",
  });
  if (result.error?.code === "ETIMEDOUT" && Number.isSafeInteger(result.pid) && result.pid > 0) {
    spawnSync(taskkill, ["/PID", String(result.pid), "/T", "/F"], {
      timeout: 5_000, maxBuffer: 4_096, windowsHide: true,
    });
  }
  return {
    exitCode: result.status,
    errorCode: result.error?.code ?? null,
    diagnosticClass: diagnosticClass(result.stderr),
    elapsedMs: Math.round(performance.now() - started),
    stderrSha256: createHash("sha256").update(String(result.stderr ?? "")).digest("hex"),
  };
}

const output = {
  role,
  tokenUserSid: sid,
  profile,
  nodeVersion: process.version,
  state: {},
  commands: {},
};

try {
  if (role === "victim") {
    output.commands.freshInstall = boundedCli(["install"]);
    output.commands.existingInstall = boundedCli(["install"]);
    if (output.commands.freshInstall.exitCode === 0) {
      output.commands.daemonStart = boundedCli(["daemon", "start"]);
      if (output.commands.daemonStart.exitCode === 0) {
        output.commands.doctor = boundedCli(["doctor"], 15_000);
      }
    }
  }
} catch (error) {
  output.actorError = error instanceof Error ? error.name : "unknown";
} finally {
  for (const name of [".lcm", ".lcm/daemon.pid", ".lcm/daemon.token"] ) {
    output.state[name] = existsSync(join(profile, name.replaceAll("/", "\\")));
  }
  if (role === "victim" && existsSync(pidPath)) {
    output.commands.daemonStop = boundedCli(["daemon", "stop"], 10_000);
    try {
      const raw = readFileSync(pidPath, "utf8").trim();
      if (/^[1-9][0-9]*$/u.test(raw)) {
        const pid = Number(raw);
        if (Number.isSafeInteger(pid) && pid > 0) {
          const script = [
            `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${raw}'`,
            "if ($null -eq $p) { 'absent'; exit 0 }",
            "$owner = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid",
            `if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne '${sid}') { exit 2 }`,
            "if ($p.CommandLine -notmatch '(?i)lcm.*daemon.*start') { exit 3 }",
            `& '${taskkill.replaceAll("'", "''")}' /PID ${raw} /T /F | Out-Null`,
            "exit $LASTEXITCODE",
          ].join("; ");
          const kill = spawnSync(powerShell, ["-NoLogo", "-NoProfile", "-NonInteractive",
            "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
            timeout: 5_000, maxBuffer: 4_096, windowsHide: true,
          });
          output.commands.finalTaskkill = { exitCode: kill.status, errorCode: kill.error?.code ?? null };
        }
      }
    } catch {
      output.commands.finalTaskkill = { errorCode: "unavailable" };
    }
  }
  writeFileSync(resultPath, JSON.stringify(output), { encoding: "utf8", mode: 0o600, flag: "wx" });
}
