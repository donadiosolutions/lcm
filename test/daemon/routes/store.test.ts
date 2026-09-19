import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemon } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { projectDbPath } from "../../../src/daemon/project.js";
import { closeLcmConnection, getLcmConnection } from "../../../src/db/connection.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("POST /store", () => {
  it("stores to SQLite promoted table", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-store-"));
    tempDirs.push(tempDir);
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "We decided to use React",
          tags: ["decision"],
          cwd: tempDir,
        }),
      });
      const data = await res.json() as { stored: boolean; id: string };
      expect(res.status).toBe(200);
      expect(data.stored).toBe(true);
      expect(data.id).toBeTruthy();
    } finally {
      await daemon.stop();
    }
  });

  it("returns 400 when text is missing", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-store-err-"));
    tempDirs.push(tempDir);
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    } finally {
      await daemon.stop();
    }
  });

  // #1371: two identical stores yield one memory. The second returns the
  // existing id with tags unioned and confidence kept at the maximum.
  it("merges an identical store into the existing memory instead of adding a second", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-store-dedup-"));
    tempDirs.push(tempDir);
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    const store = async (tags: string[]) => {
      const res = await fetch(`http://127.0.0.1:${port}/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "We agreed to keep the ledger append-only", tags, cwd: tempDir }),
      });
      expect(res.status).toBe(200);
      return await res.json() as { stored: boolean; id: string };
    };

    try {
      const first = await store(["decision"]);
      const second = await store(["ledger"]);
      const fresh = await fetch(`http://127.0.0.1:${port}/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "An unrelated note about cache warmup", cwd: tempDir }),
      });
      const freshBody = await fresh.json() as { stored: boolean; id: string };

      expect(second).toEqual({ stored: true, id: first.id });
      expect(freshBody.stored).toBe(true);
      expect(freshBody.id).not.toBe(first.id);

      const db = new DatabaseSync(projectDbPath(tempDir));
      db.exec("PRAGMA busy_timeout = 5000");
      try {
        const rows = db.prepare(
          "SELECT id, tags, confidence FROM promoted WHERE archived_at IS NULL ORDER BY created_at",
        ).all() as Array<{ id: string; tags: string; confidence: number }>;
        expect(rows.map((row) => row.id)).toEqual([first.id, freshBody.id]);
        expect(JSON.parse(rows[0].tags)).toEqual(["decision", "ledger"]);
        expect(rows[0].confidence).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      await daemon.stop();
    }
  });

  it("returns 400 when cwd is missing", async () => {
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      });
      expect(res.status).toBe(400);
    } finally {
      await daemon.stop();
    }
  });

  it("scrubs secrets before inserting into the promoted table", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-store-scrub-"));
    tempDirs.push(tempDir);
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    const secretKey = "sk-ant-api03-" + "a".repeat(40);
    const text = `My API key is ${secretKey} and should be scrubbed`;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, cwd: tempDir }),
      });
      expect(res.status).toBe(200);

      // Read back directly from the SQLite promoted table
      const dbPath = projectDbPath(tempDir);
      const db = new DatabaseSync(dbPath);
      db.exec("PRAGMA busy_timeout = 5000");
      try {
        const rows = db.prepare("SELECT content FROM promoted ORDER BY created_at DESC LIMIT 1").all() as Array<{ content: string }>;
        expect(rows).toHaveLength(1);
        expect(rows[0].content).toContain("[REDACTED]");
        expect(rows[0].content).not.toContain("sk-ant-api03");
      } finally {
        db.close();
      }
    } finally {
      await daemon.stop();
    }
  });

  it("rejects malformed tags and scrubs secrets in valid tags", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-store-tags-"));
    tempDirs.push(tempDir);
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;
    try {
      const malformed = await fetch(`http://127.0.0.1:${port}/store`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "valid", tags: { bad: "tag" }, cwd: tempDir }),
      });
      expect(malformed.status).toBe(400);

      const secret = `sk-${"a".repeat(24)}`;
      const valid = await fetch(`http://127.0.0.1:${port}/store`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "valid", tags: [`token:${secret}`], cwd: tempDir }),
      });
      expect(valid.status).toBe(200);
      const dbPath = projectDbPath(tempDir);
      const db = getLcmConnection(dbPath);
      try {
        const row = db.prepare("SELECT tags FROM promoted LIMIT 1").get() as { tags: string };
        expect(row.tags).toContain("[REDACTED]");
        expect(row.tags).not.toContain(secret);
      } finally { closeLcmConnection(dbPath); }
    } finally { await daemon.stop(); }
  });
});
