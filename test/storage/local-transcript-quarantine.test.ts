import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeLcmConnection,
  isLcmConnectionOpen,
} from "../../src/db/connection.js";
import {
  localTranscriptQuarantinePath,
  openLocalTranscriptQuarantine,
  TRANSCRIPT_QUARANTINE_SCHEMA_VERSION,
} from "../../src/storage/local-transcript-quarantine.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  closeLcmConnection();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "lcm-quarantine-open-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("local transcript quarantine construction", () => {
  it("waits for a distinct process that wins first schema creation", async () => {
    const home = temporaryDirectory();
    const dbPath = localTranscriptQuarantinePath(
      "racing-project",
      "codex",
      home,
    );
    mkdirSync(dirname(dbPath), { recursive: true });
    const child = spawn(process.execPath, [
      "--input-type=module",
      "-e",
      `
        import { DatabaseSync } from "node:sqlite";
        const db = new DatabaseSync(process.argv[1]);
        db.exec("PRAGMA journal_mode = WAL");
        db.exec("PRAGMA busy_timeout = 5000");
        db.exec("BEGIN IMMEDIATE");
        db.exec(\`
          CREATE TABLE IF NOT EXISTS transcript_quarantine (
            quarantine_id INTEGER PRIMARY KEY,
            source_locator TEXT NOT NULL CHECK (source_locator <> ''),
            source_ordinal INTEGER NOT NULL CHECK (source_ordinal >= 0),
            reason TEXT NOT NULL CHECK (reason IN (
              'invalid-utf8', 'binary-input', 'record-too-large',
              'malformed-json', 'non-container-json', 'nul-character',
              'redacted-key-collision', 'residual-secret',
              'nesting-too-deep'
            )),
            content_sha256 TEXT NOT NULL CHECK (
              length(content_sha256) = 64
              AND content_sha256 NOT GLOB '*[^0-9a-f]*'
            ),
            quarantined_at TEXT NOT NULL,
            UNIQUE (
              source_locator, source_ordinal, reason, content_sha256
            )
          ) STRICT
        \`);
        process.stdout.write("ready\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
        db.exec("COMMIT");
        db.close();
      `,
      dbPath,
    ], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const childExit = once(child, "exit");
    await once(child.stdout!, "data");

    const repository = openLocalTranscriptQuarantine(
      "racing-project",
      "codex",
      home,
    );
    await expect(repository.quarantine({
      sourceLocator: "source.jsonl",
      sourceOrdinal: 0,
      reason: "malformed-json",
      contentSha256: "a".repeat(64),
      quarantinedAt: new Date("2026-07-25T12:00:00.000Z"),
    })).resolves.toMatchObject({ sourceLocator: "source.jsonl" });
    await repository.close();
    const [exitCode] = await childExit;
    expect(exitCode).toBe(0);
  });

  it("adopts an exact unversioned schema and repairs its missing index", async () => {
    const home = temporaryDirectory();
    const dbPath = localTranscriptQuarantinePath(
      "unversioned-current",
      "claude-code",
      home,
    );
    const created = openLocalTranscriptQuarantine(
      "unversioned-current",
      "claude-code",
      home,
    );
    await created.close();
    const unversioned = new DatabaseSync(dbPath);
    unversioned.exec(`
      PRAGMA user_version = 0;
      DROP INDEX transcript_quarantine_created_idx;
    `);
    unversioned.close();

    const adopted = openLocalTranscriptQuarantine(
      "unversioned-current",
      "claude-code",
      home,
    );
    await adopted.close();
    const inspector = new DatabaseSync(dbPath);
    expect(inspector.prepare("PRAGMA user_version").get()).toEqual(
      expect.objectContaining({
        user_version: TRANSCRIPT_QUARANTINE_SCHEMA_VERSION,
      }),
    );
    expect(inspector.prepare(`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'index'
        AND name = 'transcript_quarantine_created_idx'
    `).get()).toEqual(expect.objectContaining({
      sql: expect.stringContaining("quarantined_at DESC"),
    }));
    inspector.close();

    const current = openLocalTranscriptQuarantine(
      "unversioned-current",
      "claude-code",
      home,
    );
    await current.close();
  });

  it("rejects unsupported versions and versioned or unversioned drift", async () => {
    const home = temporaryDirectory();
    const createDrift = (
      projectId: string,
      version: number,
    ): string => {
      const dbPath = localTranscriptQuarantinePath(
        projectId,
        "claude-code",
        home,
      );
      mkdirSync(dirname(dbPath), { recursive: true });
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE transcript_quarantine (wrong INTEGER) STRICT;
        PRAGMA user_version = ${version};
      `);
      db.close();
      return dbPath;
    };

    const futureVersion = TRANSCRIPT_QUARANTINE_SCHEMA_VERSION + 1;
    const futurePath = createDrift("future-version", futureVersion);
    expect(() => openLocalTranscriptQuarantine(
      "future-version",
      "claude-code",
      home,
    )).toThrowError(expect.objectContaining({
      code: "STORAGE_OPERATION_FAILED",
    }));
    const future = new DatabaseSync(futurePath);
    expect(future.prepare("PRAGMA user_version").get()).toEqual(
      expect.objectContaining({ user_version: futureVersion }),
    );
    future.close();

    const missingTablePath = localTranscriptQuarantinePath(
      "versioned-missing-table",
      "claude-code",
      home,
    );
    mkdirSync(dirname(missingTablePath), { recursive: true });
    const missingTable = new DatabaseSync(missingTablePath);
    missingTable.exec(
      `PRAGMA user_version = ${TRANSCRIPT_QUARANTINE_SCHEMA_VERSION}`,
    );
    missingTable.close();
    expect(() => openLocalTranscriptQuarantine(
      "versioned-missing-table",
      "claude-code",
      home,
    )).toThrowError(expect.objectContaining({
      code: "STORAGE_OPERATION_FAILED",
    }));

    for (const [projectId, version] of [
      ["versioned-drift", TRANSCRIPT_QUARANTINE_SCHEMA_VERSION],
      ["unversioned-drift", 0],
      ["negative-version", -1],
    ] as const) {
      const dbPath = createDrift(projectId, version);
      expect(() => openLocalTranscriptQuarantine(
        projectId,
        "claude-code",
        home,
      )).toThrowError(expect.objectContaining({
        code: "STORAGE_OPERATION_FAILED",
      }));
      const inspector = new DatabaseSync(dbPath);
      expect(inspector.prepare("PRAGMA user_version").get()).toEqual(
        expect.objectContaining({ user_version: version }),
      );
      expect(inspector.prepare(`
        SELECT sql
        FROM sqlite_master
        WHERE type = 'table' AND name = 'transcript_quarantine'
      `).get()).toEqual(expect.objectContaining({
        sql: expect.stringContaining("wrong INTEGER"),
      }));
      inspector.close();
    }

    for (const [projectId, replacementSql] of [
      [
        "versioned-index-drift",
        `DROP INDEX transcript_quarantine_created_idx;
         CREATE INDEX transcript_quarantine_created_idx
         ON transcript_quarantine (source_locator);`,
      ],
      [
        "versioned-extra-index",
        `CREATE INDEX transcript_quarantine_unexpected_idx
         ON transcript_quarantine (source_locator);`,
      ],
    ] as const) {
      const dbPath = localTranscriptQuarantinePath(
        projectId,
        "claude-code",
        home,
      );
      const valid = openLocalTranscriptQuarantine(
        projectId,
        "claude-code",
        home,
      );
      await valid.close();
      const drifted = new DatabaseSync(dbPath);
      drifted.exec(replacementSql);
      drifted.close();
      expect(() => openLocalTranscriptQuarantine(
        projectId,
        "claude-code",
        home,
      )).toThrowError(expect.objectContaining({
        code: "STORAGE_OPERATION_FAILED",
      }));
    }
  });

  it("releases the exact pooled connection when schema migration fails", () => {
    const home = temporaryDirectory();
    const dbPath = localTranscriptQuarantinePath(
      "malformed-project",
      "codex",
      home,
    );
    mkdirSync(dirname(dbPath), { recursive: true });
    const malformed = new DatabaseSync(dbPath);
    malformed.exec(`
      CREATE TABLE transcript_quarantine (
        quarantine_id INTEGER PRIMARY KEY,
        source_locator TEXT NOT NULL,
        source_ordinal INTEGER NOT NULL,
        reason TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        quarantined_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO transcript_quarantine (
        source_locator,
        source_ordinal,
        reason,
        content_sha256,
        quarantined_at
      ) VALUES (
        'source.jsonl',
        0,
        'unsupported-reason',
        '${"a".repeat(64)}',
        '2026-07-25T12:00:00.000Z'
      )
    `);
    malformed.close();

    expect(() =>
      openLocalTranscriptQuarantine("malformed-project", "codex", home)
    ).toThrow();
    expect(isLcmConnectionOpen(dbPath)).toBe(false);

    expect(() =>
      openLocalTranscriptQuarantine("malformed-project", "codex", home)
    ).toThrow();
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
  });
});
