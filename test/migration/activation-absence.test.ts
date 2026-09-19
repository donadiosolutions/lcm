import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, openSync, closeSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attributeNullableRead,
  attributeNullableValue,
  classifyNodeFsAbsence,
  NOT_FOUND_FS_CODES,
  PERMISSION_DENIED_FS_CODES,
} from "../../src/migration/activation-absence.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      chmodSync(root, 0o700);
    } catch {
      // best-effort; root may already have normal permissions
    }
    rmSync(root, { recursive: true, force: true });
  }
});

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lcm-activation-absence-"));
  roots.push(root);
  return root;
}

function unreadableFile(root: string): string {
  const path = join(root, "secret");
  writeFileSync(path, "content");
  chmodSync(path, 0o000);
  return path;
}

describe("attributeNullableRead", () => {
  it("reports present for a successful non-null read", () => {
    const outcome = attributeNullableRead(() => "value");
    expect(outcome).toEqual({ kind: "present", value: "value" });
  });

  it("reports present for a successful null read when whenNull is omitted", () => {
    const outcome = attributeNullableRead<string | null>(() => null);
    expect(outcome).toEqual({ kind: "present", value: null });
  });

  it("attributes a successful null read as absent when whenNull is supplied", () => {
    const outcome = attributeNullableRead<string | null>(() => null, {
      whenNull: { cause: "not-found", detail: "the read completed and found nothing" },
    });
    expect(outcome).toEqual({
      kind: "absent",
      cause: "not-found",
      detail: "the read completed and found nothing",
    });
  });

  it("genuinely attributes ENOENT as absent, not-found, using a real missing file", () => {
    const root = newRoot();
    const missing = join(root, "does-not-exist");
    const outcome = attributeNullableRead(() => {
      const fd = openSync(missing, "r");
      closeSync(fd);
      return "unreachable";
    });
    expect(outcome.kind).toBe("absent");
    expect(outcome).toMatchObject({ kind: "absent", cause: "not-found" });
  });

  it("genuinely attributes EACCES as unresolvable, permission-denied, using a real 0o000 file", () => {
    const root = newRoot();
    const path = unreadableFile(root);
    const outcome = attributeNullableRead(() => {
      const fd = openSync(path, "r");
      closeSync(fd);
      return "unreachable";
    });
    expect(outcome).toMatchObject({ kind: "unresolvable", cause: "permission-denied" });
  });

  it("naive baseline: a plain try/catch that collapses every error into null" +
    " wrongly reports the same 0o000 fixture as absent, which would wrongly" +
    " let a quiescence/coverage assertion pass", () => {
    const root = newRoot();
    const path = unreadableFile(root);
    const naiveRead = (): string | null => {
      try {
        const fd = openSync(path, "r");
        closeSync(fd);
        return "unreachable";
      } catch {
        return null;
      }
    };
    expect(naiveRead()).toBeNull();

    const attributed = attributeNullableRead(() => {
      const fd = openSync(path, "r");
      closeSync(fd);
      return "unreachable";
    });
    expect(attributed.kind).toBe("unresolvable");
    expect(attributed.kind).not.toBe("absent");
  });

  it("propagates an unrecognized error unchanged rather than guessing", () => {
    const boom = new Error("unexpected failure with no errno code");
    expect(() => attributeNullableRead<string>(() => { throw boom; })).toThrowError(boom);
  });

  it("propagates an error carrying an unrecognized errno code unchanged", () => {
    const boom = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    expect(() => attributeNullableRead<string>(() => { throw boom; })).toThrowError(boom);
  });

  it("uses a caller-supplied classifier instead of the default", () => {
    const boom = new Error("custom failure");
    const outcome = attributeNullableRead<string>(() => { throw boom; }, {
      classifyError: (error) => (error === boom
        ? { kind: "unresolvable", cause: "custom-cause", detail: "custom detail" }
        : undefined),
    });
    expect(outcome).toEqual({ kind: "unresolvable", cause: "custom-cause", detail: "custom detail" });
  });

  it("accepts caller-supplied not-found and permission-denied code lists", () => {
    const notFound = Object.assign(new Error("custom not found"), { code: "ECUSTOM_MISSING" });
    const outcomeAbsent = attributeNullableRead<string>(() => { throw notFound; }, {
      classifyError: classifyNodeFsAbsence({ notFoundCodes: ["ECUSTOM_MISSING"] }),
    });
    expect(outcomeAbsent).toMatchObject({ kind: "absent", cause: "not-found" });

    const denied = Object.assign(new Error("custom denial"), { code: "ECUSTOM_DENIED" });
    const outcomeDenied = attributeNullableRead<string>(() => { throw denied; }, {
      classifyError: classifyNodeFsAbsence({ permissionDeniedCodes: ["ECUSTOM_DENIED"] }),
    });
    expect(outcomeDenied).toMatchObject({ kind: "unresolvable", cause: "permission-denied" });
  });

  it("treats an error without a string .code as unrecognized", () => {
    const boom = Object.assign(new Error("weird"), { code: 42 });
    expect(() => attributeNullableRead<string>(() => { throw boom; })).toThrowError(boom);
  });

  it("exposes the default code lists as read-only exports", () => {
    expect(NOT_FOUND_FS_CODES).toContain("ENOENT");
    expect(PERMISSION_DENIED_FS_CODES).toContain("EACCES");
  });
});

describe("attributeNullableValue", () => {
  it("reports present for a defined, non-null value", () => {
    expect(attributeNullableValue("row", { cause: "not-in-roster", detail: "unused" }))
      .toEqual({ kind: "present", value: "row" });
  });

  it("attributes undefined as absent with the supplied cause", () => {
    expect(attributeNullableValue(undefined, { cause: "not-in-roster", detail: "no roster row for this machine" }))
      .toEqual({ kind: "absent", cause: "not-in-roster", detail: "no roster row for this machine" });
  });

  it("attributes null as absent with the supplied cause", () => {
    expect(attributeNullableValue(null, { cause: "not-found", detail: "nothing there" }))
      .toEqual({ kind: "absent", cause: "not-found", detail: "nothing there" });
  });

  it("treats a falsy-but-defined value (0, empty string, false) as present", () => {
    expect(attributeNullableValue(0, { cause: "unused", detail: "unused" })).toEqual({ kind: "present", value: 0 });
    expect(attributeNullableValue("", { cause: "unused", detail: "unused" })).toEqual({ kind: "present", value: "" });
    expect(attributeNullableValue(false, { cause: "unused", detail: "unused" })).toEqual({ kind: "present", value: false });
  });
});
