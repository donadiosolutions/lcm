import { beforeAll, it } from "vitest";
import { emitCanonicalEvidence } from "./portable-evidence.js";
import { assertHarnessReady } from "./harness.js";
import { assertSqliteCanonicalTransfer } from "./portable-sqlite-fixture.js";

// This direction belongs to every PG conformance repetition, even though its
// independently seeded source and destination deliberately need no PG database.
beforeAll(assertHarnessReady);

it("copies the same independent 22-domain native SQLite corpus into a fresh SQLite archive",
  async () => {
    const manifest = await assertSqliteCanonicalTransfer();
    emitCanonicalEvidence("sqlite->sqlite", manifest);
  }, 120_000);
