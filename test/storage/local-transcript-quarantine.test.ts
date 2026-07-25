import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
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
