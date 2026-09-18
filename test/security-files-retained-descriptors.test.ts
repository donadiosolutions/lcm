import { describe, expect, it } from "vitest";
import {
  retainedDescriptorIdentities,
  UnsupportedPlatformCapabilityError,
} from "../src/security-files.js";

type StatFixture = Readonly<{ dev: bigint; ino: bigint; mode: bigint }>;

type DescriptorFixture = Readonly<{
  entries: readonly string[];
  links: Readonly<Record<string, string | Error>>;
  stats: Readonly<Record<string, StatFixture | Error>>;
}>;

const REGULAR_FILE = 0o100600n;
const DIRECTORY = 0o040700n;

function errorWithCode(code: string): Error {
  return Object.assign(new Error(`injected ${code}`), { code });
}

function operations(fixture: DescriptorFixture) {
  return {
    readdir: () => fixture.entries,
    readlink: (path: string) => {
      const link = fixture.links[path];
      if (link === undefined) throw errorWithCode("ENOENT");
      if (link instanceof Error) throw link;
      return link;
    },
    stat: (path: string) => {
      const stat = fixture.stats[path];
      if (stat === undefined) throw errorWithCode("ENOENT");
      if (stat instanceof Error) throw stat;
      return {
        isDirectory: () => (stat.mode & 0o170000n) === DIRECTORY,
        mode: stat.mode,
        uid: 0n,
        gid: 0n,
        nlink: 1n,
        dev: stat.dev,
        ino: stat.ino,
      };
    },
  };
}

describe("retainedDescriptorIdentities", () => {
  it("reports the link, identity, and kind of every retained descriptor", () => {
    const identities = retainedDescriptorIdentities(operations({
      entries: ["7", "9", "11"],
      links: {
        "/proc/self/fd/7": "/database/main.sqlite",
        "/proc/self/fd/9": "/database",
        "/proc/self/fd/11": "socket:[41]",
      },
      stats: {
        "/proc/self/fd/7": { dev: 64n, ino: 11n, mode: REGULAR_FILE },
        "/proc/self/fd/9": { dev: 64n, ino: 4n, mode: DIRECTORY },
        "/proc/self/fd/11": { dev: 0n, ino: 41n, mode: 0o140777n },
      },
    }));

    expect(identities).toEqual([
      { fd: 7, link: "/database/main.sqlite", dev: 64n, ino: 11n, isFile: true },
      { fd: 9, link: "/database", dev: 64n, ino: 4n, isFile: false },
      { fd: 11, link: "socket:[41]", dev: 0n, ino: 41n, isFile: false },
    ]);
  });

  it.each([
    ["a non-numeric namespace entry", "self"],
    ["a negative namespace entry", "-1"],
  ])("skips %s", (_label, entry) => {
    const identities = retainedDescriptorIdentities(operations({
      entries: [entry, "4"],
      links: {
        [`/proc/self/fd/${entry}`]: "/database/other.sqlite",
        "/proc/self/fd/4": "/database/main.sqlite",
      },
      stats: {
        [`/proc/self/fd/${entry}`]: { dev: 64n, ino: 99n, mode: REGULAR_FILE },
        "/proc/self/fd/4": { dev: 64n, ino: 11n, mode: REGULAR_FILE },
      },
    }));

    expect(identities).toEqual([
      { fd: 4, link: "/database/main.sqlite", dev: 64n, ino: 11n, isFile: true },
    ]);
  });

  it.each([
    ["ENOENT", "ENOENT"],
    ["EBADF", "EBADF"],
  ])("skips a descriptor closed before its link read with %s", (_label, code) => {
    const identities = retainedDescriptorIdentities(operations({
      entries: ["4", "5"],
      links: {
        "/proc/self/fd/4": errorWithCode(code),
        "/proc/self/fd/5": "/database/main.sqlite",
      },
      stats: { "/proc/self/fd/5": { dev: 64n, ino: 11n, mode: REGULAR_FILE } },
    }));

    expect(identities).toEqual([
      { fd: 5, link: "/database/main.sqlite", dev: 64n, ino: 11n, isFile: true },
    ]);
  });

  it.each([
    ["ENOENT", "ENOENT"],
    ["EBADF", "EBADF"],
  ])("skips a descriptor closed before its identity read with %s", (_label, code) => {
    const identities = retainedDescriptorIdentities(operations({
      entries: ["4", "5"],
      links: {
        "/proc/self/fd/4": "/database/main.sqlite",
        "/proc/self/fd/5": "/database/main.sqlite",
      },
      stats: {
        "/proc/self/fd/4": errorWithCode(code),
        "/proc/self/fd/5": { dev: 64n, ino: 11n, mode: REGULAR_FILE },
      },
    }));

    expect(identities).toEqual([
      { fd: 5, link: "/database/main.sqlite", dev: 64n, ino: 11n, isFile: true },
    ]);
  });

  it("propagates an unexpected link failure", () => {
    expect(() => retainedDescriptorIdentities(operations({
      entries: ["4"],
      links: { "/proc/self/fd/4": errorWithCode("EACCES") },
      stats: {},
    }))).toThrow("injected EACCES");
  });

  it("propagates an unexpected identity failure", () => {
    expect(() => retainedDescriptorIdentities(operations({
      entries: ["4"],
      links: { "/proc/self/fd/4": "/database/main.sqlite" },
      stats: { "/proc/self/fd/4": errorWithCode("EACCES") },
    }))).toThrow("injected EACCES");
  });

  it("propagates a descriptor failure that carries no error code", () => {
    expect(() => retainedDescriptorIdentities(operations({
      entries: ["4"],
      links: { "/proc/self/fd/4": new Error("injected failure without a code") },
      stats: {},
    }))).toThrow("injected failure without a code");
  });

  it("refuses an unavailable descriptor namespace", () => {
    expect(() => retainedDescriptorIdentities({
      readdir: () => { throw errorWithCode("ENOENT"); },
    })).toThrow(UnsupportedPlatformCapabilityError);
  });
});

