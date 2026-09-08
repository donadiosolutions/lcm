import { expect, it } from "vitest";
import { PrivateMutationLockContentionError } from "../../dist/src/private-mutation-lock.js";
import { withImportCatalogAdmission } from "../postgresql/fixtures/surface-parity-imports.mjs";

it("retries the actual private admission class despite its default Error name", async () => {
  const contention = new PrivateMutationLockContentionError("private fixture admission");
  expect(contention.name).toBe("Error");
  let calls = 0;
  const result = await withImportCatalogAdmission(async () => {
    if (++calls === 1) throw contention;
    return "admitted";
  }, "claude");
  expect(result).toBe("admitted");
  expect(calls).toBe(2);
});

it("does not retry an unrelated error impersonating the class name", async () => {
  const unrelated = new Error("private fixture failure");
  unrelated.name = "PrivateMutationLockContentionError";
  let calls = 0;
  await expect(withImportCatalogAdmission(async () => {
    calls++;
    throw unrelated;
  }, "codex")).rejects.toBe(unrelated);
  expect(calls).toBe(1);
});
