import { describe, expect, it } from "vitest";
import { StorageOperationError } from "../../src/storage/errors.js";
import {
  isPostgreSqlConnectionError,
  isPostgreSqlSnapshotTerminationError,
  isRetryablePostgreSqlError,
  normalizePostgreSqlError,
  PostgreSqlCommitOutcomeUnknownError,
} from "../../src/storage/postgresql/errors.js";

describe("PostgreSQL error normalization", () => {
  it.each(["08000", "08001", "08003", "08004", "08006", "08007", "08P01", "40001", "40P01", "53300", "57P01", "57P02", "57P03"])(
    "classifies SQLSTATE %s as retryable",
    (code) => expect(isRetryablePostgreSqlError(Object.assign(new Error("driver secret"), { code }))).toBe(true),
  );

  it.each([
    "EAI_AGAIN",
    "ECONNABORTED",
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTDOWN",
    "EHOSTUNREACH",
    "ENETDOWN",
    "ENETRESET",
    "ENETUNREACH",
    "EPIPE",
    "ETIMEDOUT",
  ])("classifies transient Node transport code %s as retryable", (code) => {
    expect(isRetryablePostgreSqlError(Object.assign(new Error("transport secret"), { code }))).toBe(true);
  });

  it.each([
    "Connection terminated due to connection timeout",
    "Connection terminated unexpectedly",
    "Query read timeout",
    "timeout exceeded when trying to connect",
    "timeout expired",
  ])("classifies pg driver failure %s as retryable without SQLSTATE", (message) => {
    expect(isRetryablePostgreSqlError(new Error(message))).toBe(true);
  });

  it.each([
    { code: "08006", message: "private" },
    { code: "57P01", message: "private" },
    { code: "ECONNRESET", message: "private" },
    { message: "Connection terminated unexpectedly" },
    { message: "Query read timeout" },
  ])("identifies connection-level failure %#", ({ code, message }) => {
    expect(isPostgreSqlConnectionError(Object.assign(new Error(message), { code }))).toBe(true);
  });

  it.each([
    { code: "40001", message: "serialization failure" },
    { code: "40P01", message: "deadlock" },
    { code: "53300", message: "too many connections" },
    { code: "23505", message: "unique violation" },
    { code: "080000", message: "malformed SQLSTATE" },
  ])("does not identify ordinary SQL or malformed failure %# as connection-level", ({ code, message }) => {
    expect(isPostgreSqlConnectionError(Object.assign(new Error(message), { code }))).toBe(false);
  });

  it.each([
    undefined,
    null,
    {},
    { code: 123 },
    { code: "23505" },
    Object.assign(new Error("unknown timeout"), { code: "ENOTFOUND" }),
  ])("does not retry unsafe value %#", (error) => {
    expect(isRetryablePostgreSqlError(error)).toBe(false);
  });

  it("returns existing safe errors unchanged", () => {
    const safe = new StorageOperationError("STORAGE_CLOSED", "postgresql", "project", "factory", "query");
    expect(normalizePostgreSqlError(safe, { domain: "factory", operation: "ignored" })).toBe(safe);
  });

  it("sanitizes driver details while retaining retry classification and context", () => {
    const driver = Object.assign(new Error("password=sensitive values=[secret]"), { code: "40001", detail: "private" });
    const normalized = normalizePostgreSqlError(driver, {
      projectId: "project",
      machineId: "machine",
      domain: "sessions",
      operation: "write",
    }, "STORAGE_INITIALIZATION_FAILED");
    expect(normalized).toMatchObject({
      code: "STORAGE_INITIALIZATION_FAILED",
      backend: "postgresql",
      projectId: "project",
      machineId: "machine",
      domain: "sessions",
      operation: "write",
      retryable: true,
      sqlState: "40001",
    });
    expect(normalized.toJSON()).toMatchObject({
      sqlState: "40001",
      machineId: "machine",
    });
    expect(JSON.stringify(normalized)).not.toContain("sensitive");
    const withoutMachine = normalizePostgreSqlError(
      new Error("failure"),
      { domain: "factory", operation: "query" },
    );
    expect(withoutMachine)
      .toMatchObject({ code: "STORAGE_OPERATION_FAILED", retryable: false, sqlState: null });
    expect(withoutMachine.toJSON()).not.toHaveProperty("machineId");
    expect(normalizePostgreSqlError(
      Object.assign(new Error("failure"), { code: "bad-state" }),
      { domain: "factory", operation: "query" },
    )).toMatchObject({ sqlState: null });
  });

  it("serializes optional machine context for ambiguous commits", () => {
    expect(new PostgreSqlCommitOutcomeUnknownError({
      projectId: "project",
      machineId: "machine",
      domain: "transaction",
      operation: "commit",
    }).toJSON()).toMatchObject({ machineId: "machine" });
    expect(new PostgreSqlCommitOutcomeUnknownError({
      projectId: "project",
      domain: "transaction",
      operation: "commit",
    }).toJSON()).not.toHaveProperty("machineId");
  });

  it.each(["25P03", "08000", "08006", "57P01", "57P02", "57P03", "ECONNRESET", "ETIMEDOUT"])(
    "classifies raw driver failure %s as a snapshot termination, unlike the wider connection-error helper",
    (code) => {
      const raw = Object.assign(new Error("driver secret"), { code });
      expect(isPostgreSqlSnapshotTerminationError(raw)).toBe(true);
    },
  );

  it("does not classify 25P03 as a connection error, only as a snapshot termination", () => {
    const idleKill = Object.assign(new Error("idle-in-transaction session timeout"), { code: "25P03" });
    expect(isPostgreSqlConnectionError(idleKill)).toBe(false);
    expect(isPostgreSqlSnapshotTerminationError(idleKill)).toBe(true);
  });

  it.each(["23505", "40001", "080000"])(
    "does not classify ordinary or malformed SQLSTATE %s as a snapshot termination",
    (code) => {
      expect(isPostgreSqlSnapshotTerminationError(Object.assign(new Error("private"), { code }))).toBe(false);
    },
  );

  it("reads sqlState from an already-normalized PostgreSqlStorageOperationError", () => {
    const idleKill = normalizePostgreSqlError(
      Object.assign(new Error("idle-in-transaction session timeout"), { code: "25P03" }),
      { domain: "transaction", operation: "snapshot", projectId: "project" },
    );
    expect(isPostgreSqlSnapshotTerminationError(idleKill)).toBe(true);
    const ordinary = normalizePostgreSqlError(
      Object.assign(new Error("unique violation"), { code: "23505" }),
      { domain: "transaction", operation: "snapshot", projectId: "project" },
    );
    expect(isPostgreSqlSnapshotTerminationError(ordinary)).toBe(false);
    const unknownState = normalizePostgreSqlError(
      new Error("unknown driver failure"),
      { domain: "transaction", operation: "snapshot", projectId: "project" },
    );
    expect(isPostgreSqlSnapshotTerminationError(unknownState)).toBe(false);
  });

  it.each([undefined, null, {}, { code: 123 }])(
    "does not classify unsafe value %# as a snapshot termination",
    (error) => {
      expect(isPostgreSqlSnapshotTerminationError(error)).toBe(false);
    },
  );

  it("tolerates a live message-only torn connection but not a live generic not-queryable rejection", () => {
    const context = { domain: "transaction", operation: "snapshot", projectId: "project" } as const;
    // idle_in_transaction_session_timeout fires with no query in flight;
    // the FATAL never reaches the operation's own rejection. What the
    // operation actually rejects with, after the socket end follows, is
    // this message-only shape (RETRYABLE_DRIVER_MESSAGES match, no code).
    const tornConnection = normalizePostgreSqlError(new Error("Connection terminated unexpectedly"), context);
    expect(tornConnection).toMatchObject({ sqlState: null, retryable: true });
    expect(isPostgreSqlSnapshotTerminationError(tornConnection)).toBe(true);

    const queryTimeout = normalizePostgreSqlError(new Error("Query read timeout"), context);
    expect(queryTimeout).toMatchObject({ sqlState: null, retryable: true });
    expect(isPostgreSqlSnapshotTerminationError(queryTimeout)).toBe(true);

    // A generic "not queryable" local rejection (what pg's Client.query
    // produces once _queryable is false, with no code and not in
    // RETRYABLE_DRIVER_MESSAGES) must NOT be tolerated on its own: an
    // ordinary, undiagnosed dead session looks exactly like this too, and
    // the whole point of the async-failure listener + reattach is that
    // this predicate should not have to guess.
    const notQueryable = normalizePostgreSqlError(
      new Error("Client has encountered a connection error and is not queryable"), context,
    );
    expect(notQueryable).toMatchObject({ sqlState: null, retryable: false });
    expect(isPostgreSqlSnapshotTerminationError(notQueryable)).toBe(false);

    // retryable alone, without a null sqlState, is never sufficient: 40001
    // keeps its own sqlState through normalization and is retryable, but
    // it is a serialization failure, not a connection termination.
    const serializationFailure = normalizePostgreSqlError(
      Object.assign(new Error("could not serialize access"), { code: "40001" }), context,
    );
    expect(serializationFailure).toMatchObject({ sqlState: "40001", retryable: true });
    expect(isPostgreSqlSnapshotTerminationError(serializationFailure)).toBe(false);
  });
});
