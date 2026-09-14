import { expect, it } from "vitest";
import { assertLogicalSnapshotUnchanged } from "./assertions.mjs";
import { assertRestartSnapshotUnchanged } from "./restart-snapshot.mjs";

const owner = 1000;
function snapshot() {
  const file = { kind: "file", mode: 0o100600, uid: owner, gid: owner, nlink: 1, inode: 10, dev: 1, sha256: "bytes", bytes: 4096 };
  const directory = { kind: "directory", mode: 0o40700, uid: owner, gid: owner, nlink: 2, inode: 2, dev: 1 };
  return { entries: {
    "config.json": { ...file, inode: 3 },
    projects: { ...directory, children: ["fixture"] },
    "projects/fixture": { ...directory, inode: 4, children: ["db.sqlite", "db.sqlite-shm", "db.sqlite-wal"] },
    "projects/fixture/db.sqlite": { ...file, sqliteFile: true, database: { schemaSha256: "schema", tables: { messages: { rows: 2, sha256: "rows" } }, userVersion: 1, journalMode: "wal" } },
    "projects/fixture/db.sqlite-wal": { ...file, inode: 11 },
    "projects/fixture/db.sqlite-shm": { ...file, inode: 12 },
  } };
}

it("accepts authenticated WAL/SHM recreation while the live comparator remains strict", () => {
  const before = snapshot();
  const after = snapshot();
  after.entries["projects/fixture/db.sqlite-wal"].inode = 21;
  after.entries["projects/fixture/db.sqlite-shm"].inode = 22;
  expect(() => assertLogicalSnapshotUnchanged(after, before, "live", { owner })).toThrow();
  expect(() => assertRestartSnapshotUnchanged(after, before, owner)).not.toThrow();
});

it.each([
  ["rows", (value: ReturnType<typeof snapshot>) => { value.entries["projects/fixture/db.sqlite"].database.tables.messages.sha256 = "different"; }],
  ["schema", (value: ReturnType<typeof snapshot>) => { value.entries["projects/fixture/db.sqlite"].database.schemaSha256 = "different"; }],
  ["policy", (value: ReturnType<typeof snapshot>) => { value.entries["projects/fixture/db.sqlite"].database.userVersion = 2; }],
  ["database identity", (value: ReturnType<typeof snapshot>) => { value.entries["projects/fixture/db.sqlite"].inode = 20; }],
  ["config", (value: ReturnType<typeof snapshot>) => { value.entries["config.json"].sha256 = "different"; }],
  ["root", (value: ReturnType<typeof snapshot>) => { value.entries.projects.inode = 20; }],
  ["WAL owner", (value: ReturnType<typeof snapshot>) => { value.entries["projects/fixture/db.sqlite-wal"].uid = 999; }],
  ["WAL device", (value: ReturnType<typeof snapshot>) => { value.entries["projects/fixture/db.sqlite-wal"].dev = 2; }],
  ["WAL mode", (value: ReturnType<typeof snapshot>) => { value.entries["projects/fixture/db.sqlite-wal"].mode = 0o100644; }],
] as const)("rejects changed %s across a restart", (_name, mutate) => {
  const before = snapshot();
  const after = snapshot();
  after.entries["projects/fixture/db.sqlite-wal"].inode = 21;
  mutate(after);
  expect(() => assertRestartSnapshotUnchanged(after, before, owner)).toThrow();
});

it("rejects an unknown added file", () => {
  const before = snapshot();
  const after = snapshot();
  Object.assign(after.entries, { "projects/fixture/unexpected": { ...after.entries["config.json"] } });
  expect(() => assertRestartSnapshotUnchanged(after, before, owner)).toThrow();
});
