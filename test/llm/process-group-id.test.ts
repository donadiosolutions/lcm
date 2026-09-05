import { afterEach, describe, expect, it, vi } from "vitest";

const unexpectedProcfsRead = new Error("unexpected procfs read");
const readProcfsStat = vi.hoisted(() => vi.fn(() => {
  throw unexpectedProcfsRead;
}));

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: readProcfsStat };
});

import { __processUtilsTestUtils } from "../../src/llm/process-utils.js";

const fixture = {
  pid: 43123,
  statPid: 43123,
  comm: "provider worker 55123) spaces",
  ppid: 64123,
  session: 84123,
};

function statFixture(group: string): string {
  return `${fixture.statPid} (${fixture.comm}) S ${fixture.ppid} ${group} ${fixture.session} 0 0 0 0`;
}

describe("linux process-group identity parser", () => {
  afterEach(() => {
    readProcfsStat.mockReset();
    readProcfsStat.mockImplementation(() => {
      throw unexpectedProcfsRead;
    });
  });

  it.each([
    ["positive", "74123", 74123],
    ["zero", "0", undefined],
    ["negative", "-17", undefined],
    ["fractional", "12.5", undefined],
    ["non-numeric", "not-a-number", undefined],
    ["empty", "", undefined],
  ] as const)("returns the safe group identity for a %s field", (_name, group, expected) => {
    const raw = statFixture(group);
    readProcfsStat.mockImplementationOnce(() => raw);

    expect(__processUtilsTestUtils.linuxProcessGroupId(fixture.pid)).toBe(expected);
    expect(readProcfsStat).toHaveBeenCalledTimes(1);
    expect(readProcfsStat).toHaveBeenCalledWith(`/proc/${fixture.pid}/stat`, "utf8");
    expect(readProcfsStat.mock.results[0]?.type).toBe("return");
    expect(readProcfsStat.mock.results[0]?.value).toBe(raw);
  });

  it("returns undefined when procfs stat cannot be read", () => {
    expect(__processUtilsTestUtils.linuxProcessGroupId(fixture.pid)).toBeUndefined();
    expect(readProcfsStat).toHaveBeenCalledTimes(1);
    expect(readProcfsStat).toHaveBeenCalledWith(`/proc/${fixture.pid}/stat`, "utf8");
    expect(readProcfsStat.mock.results[0]?.type).toBe("throw");
    expect(readProcfsStat.mock.results[0]?.value).toBe(unexpectedProcfsRead);
  });
});

describe("default process-group liveness probe", () => {
  it("returns true when signal zero succeeds", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      expect(__processUtilsTestUtils.defaultProcessGroupAlive(7312)).toBe(true);
      expect(kill).toHaveBeenCalledWith(-7312, 0);
    } finally {
      kill.mockRestore();
    }
  });

  it("returns false when signal zero reports ESRCH", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    try {
      expect(__processUtilsTestUtils.defaultProcessGroupAlive(7313)).toBe(false);
      expect(kill).toHaveBeenCalledWith(-7313, 0);
    } finally {
      kill.mockRestore();
    }
  });

  it("returns true when signal zero reports another error", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    try {
      expect(__processUtilsTestUtils.defaultProcessGroupAlive(7314)).toBe(true);
      expect(kill).toHaveBeenCalledWith(-7314, 0);
    } finally {
      kill.mockRestore();
    }
  });

  it("returns true when signal zero throws without an error code", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("unknown");
    });
    try {
      expect(__processUtilsTestUtils.defaultProcessGroupAlive(7315)).toBe(true);
      expect(kill).toHaveBeenCalledWith(-7315, 0);
    } finally {
      kill.mockRestore();
    }
  });
});
