import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  daemonJsonRequest,
  daemonPortFromLoopbackUrl,
  normalizeDaemonPath,
  normalizeDaemonPort,
  normalizeIdleTimeoutMs,
} from "../../src/daemon/http-url.js";
import { ensureAuthToken, readAuthToken } from "../../src/daemon/auth.js";
import {
  ensureProjectDir, isSafeTranscriptPath, projectCanonicalPath, projectDbPath, projectDir,
  projectIdentity, projectMetaPath, projectPaths,
} from "../../src/daemon/project.js";
import { validateCwd } from "../../src/daemon/validate-cwd.js";

const tempDirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function listen(handler: Parameters<typeof createServer>[0]): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

describe("daemon URL validation boundaries", () => {
  it.each([
    [3737, {}, 3737], ["42", {}, 42], [0, { allowZero: true }, 0],
  ] as const)("normalizes port %#", (value, options, expected) => {
    expect(normalizeDaemonPort(value, options)).toBe(expected);
  });

  it.each([undefined, "x", 1.5, 0, -1, 65_536])("rejects invalid port %s", value => {
    expect(() => normalizeDaemonPort(value)).toThrow("Invalid daemon port");
  });

  it.each([[0, 0], ["120", 120], [86_400_000, 86_400_000]] as const)("normalizes timeout %#", (value, expected) => {
    expect(normalizeIdleTimeoutMs(value)).toBe(expected);
  });

  it.each([undefined, "x", -1, 1.5, 86_400_001])("rejects invalid timeout %s", value => {
    expect(() => normalizeIdleTimeoutMs(value)).toThrow("Invalid daemon idle timeout");
  });

  it.each([
    ["http://127.0.0.1:3737", 3737], ["http://localhost", 80],
    ["http://[::1]:4444", 4444],
  ] as const)("extracts a loopback port from %s", (url, expected) => {
    expect(daemonPortFromLoopbackUrl(url)).toBe(expected);
  });

  it.each([
    "https://localhost:3737", "http://example.com:3737", "http://user@localhost:3737",
    "http://user:pass@localhost:3737", "http://localhost:3737/path", "http://localhost:3737/?x=1",
    "http://localhost:3737/#x",
  ])("rejects non-origin daemon URL %s", url => {
    expect(() => daemonPortFromLoopbackUrl(url)).toThrow("HTTP loopback origin");
  });

  it("accepts only known daemon paths", () => {
    expect(normalizeDaemonPath("/health")).toBe("/health");
    expect(() => normalizeDaemonPath("/unknown")).toThrow("Invalid daemon route");
  });
});

describe("daemon JSON transport", () => {
  it("sends JSON with caller headers and parses chunked JSON responses", async () => {
    const port = await listen((req, res) => {
      expect(req.method).toBe("POST");
      expect(req.headers["x-test"]).toBe("yes");
      expect(req.headers["content-length"]).toBe("7");
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        expect(body).toBe('{"a":1}');
        res.writeHead(200);
        res.write('{"ok":');
        res.end("true}");
      });
    });
    await expect(daemonJsonRequest<{ ok: boolean }>(port, "/store", {
      method: "POST", headers: { "X-Test": "yes" }, body: { a: 1 },
    })).resolves.toEqual({ ok: true });
  });

  it("handles empty success, structured and fallback HTTP errors", async () => {
    const empty = await listen((_req, res) => { res.writeHead(204); res.end(); });
    await expect(daemonJsonRequest(empty, "/health", { method: "GET" })).resolves.toBeUndefined();

    const structured = await listen((_req, res) => { res.writeHead(422); res.end('{"error":"bad input"}'); });
    await expect(daemonJsonRequest(structured, "/health", { method: "GET" })).rejects.toThrow("bad input");

    const fallback = await listen((_req, res) => { res.writeHead(503); res.end("null"); });
    await expect(daemonJsonRequest(fallback, "/health", { method: "GET" })).rejects.toThrow("HTTP 503");

    const objectFallback = await listen((_req, res) => { res.writeHead(400); res.end('{"error":42}'); });
    await expect(daemonJsonRequest(objectFallback, "/health", { method: "GET" })).rejects.toThrow("HTTP 400");

    const missingError = await listen((_req, res) => { res.writeHead(400); res.end('{"message":"no"}'); });
    await expect(daemonJsonRequest(missingError, "/health", { method: "GET" })).rejects.toThrow("HTTP 400");

    const emptyError = await listen((_req, res) => { res.writeHead(400); res.end(); });
    await expect(daemonJsonRequest(emptyError, "/health", { method: "GET" })).rejects.toThrow("HTTP 400");
  });

  it("rejects malformed JSON, socket failures, and request timeouts", async () => {
    const malformed = await listen((_req, res) => { res.writeHead(200); res.end("{"); });
    await expect(daemonJsonRequest(malformed, "/health", { method: "GET" })).rejects.toBeInstanceOf(SyntaxError);

    const unused = await listen((_req, res) => res.end());
    await new Promise<void>(resolve => servers.pop()!.close(() => resolve()));
    await expect(daemonJsonRequest(unused, "/health", { method: "GET" })).rejects.toBeInstanceOf(Error);

    const hanging = await listen(() => {});
    await expect(daemonJsonRequest(hanging, "/health", { method: "GET", timeoutMs: 5 })).rejects.toThrow("timed out");
  });
});

describe("filesystem boundary fallbacks", () => {
  it("returns null for an empty auth token and tolerates an existing token path", () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-core-auth-")); tempDirs.push(dir);
    const path = join(dir, "token");
    writeFileSync(path, "  \n");
    expect(readAuthToken(path)).toBeNull();
    expect(() => ensureAuthToken(path)).not.toThrow();
  });

  it("validates transcript symlinks and updates malformed or stale project metadata", () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-core-project-")); tempDirs.push(cwd);
    const inside = join(cwd, "inside.jsonl"); writeFileSync(inside, "");
    const outsideDir = mkdtempSync(join(tmpdir(), "lcm-core-outside-")); tempDirs.push(outsideDir);
    const outside = join(outsideDir, "outside.jsonl"); writeFileSync(outside, "");
    const safeLink = join(cwd, "safe-link"); symlinkSync(inside, safeLink);
    const unsafeLink = join(cwd, "unsafe-link"); symlinkSync(outside, unsafeLink);
    const brokenLink = join(cwd, "broken-link"); symlinkSync(join(cwd, "missing"), brokenLink);
    expect(isSafeTranscriptPath(safeLink, cwd)).toBe(inside);
    expect(isSafeTranscriptPath(unsafeLink, cwd)).toBe(false);
    expect(isSafeTranscriptPath(brokenLink, cwd)).toBe(false);
    expect(isSafeTranscriptPath(join(cwd, "missing", "future.jsonl"), cwd)).toBe(join(cwd, "missing", "future.jsonl"));
    expect(isSafeTranscriptPath(outside, cwd)).toBe(false);

    expect(projectIdentity(cwd).canonical).toBe(cwd);
    expect(projectCanonicalPath(cwd)).toBe(cwd);
    expect(projectPaths(cwd).dbPath).toBe(projectDbPath(cwd));
    expect(projectDir(cwd)).toBe(projectPaths(cwd).dir);
    expect(projectMetaPath(cwd)).toBe(projectPaths(cwd).metaPath);

    const oldHome = process.env.HOME;
    process.env.HOME = cwd;
    try {
      const dir = ensureProjectDir(cwd);
      const meta = join(dir, "meta.json");
      writeFileSync(meta, "{bad");
      expect(ensureProjectDir(cwd)).toBe(dir);
      writeFileSync(meta, JSON.stringify({ cwd: "/stale", keep: true }));
      ensureProjectDir(cwd);
      expect(JSON.parse(readFileSync(meta, "utf-8"))).toMatchObject({ cwd, keep: true });
      expect(ensureProjectDir(cwd)).toBe(dir);
    } finally {
      if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    }
  });

  it("sanitizes non-ENOENT stat failures and falls back when realpath fails", () => {
    expect(() => validateCwd(42 as unknown as string)).toThrow("cwd is required");
    const dir = mkdtempSync(join(tmpdir(), "lcm-core-file-")); tempDirs.push(dir);
    const file = join(dir, "file");
    writeFileSync(file, "x");
    expect(() => validateCwd(file)).toThrow("cwd must be a directory");
  });
});
