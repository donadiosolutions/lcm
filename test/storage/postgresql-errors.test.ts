import { describe, expect, it } from "vitest";
import { StorageOperationError } from "../../src/storage/errors.js";
import {
  isRetryablePostgreSqlError,
  normalizePostgreSqlError,
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
    "timeout exceeded when trying to connect",
    "timeout expired",
  ])("classifies pg driver failure %s as retryable without SQLSTATE", (message) => {
    expect(isRetryablePostgreSqlError(new Error(message))).toBe(true);
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
      domain: "sessions",
      operation: "write",
    }, "STORAGE_INITIALIZATION_FAILED");
    expect(normalized).toMatchObject({
      code: "STORAGE_INITIALIZATION_FAILED",
      backend: "postgresql",
      projectId: "project",
      domain: "sessions",
      operation: "write",
      retryable: true,
    });
    expect(JSON.stringify(normalized)).not.toContain("sensitive");
    expect(normalizePostgreSqlError(new Error("failure"), { domain: "factory", operation: "query" }))
      .toMatchObject({ code: "STORAGE_OPERATION_FAILED", retryable: false });
  });
});
