import { eventsDbPath } from "../db/events-path.js";
import {
  SQLiteLocalHookOutboxFactory,
  type LocalHookEvent,
} from "../storage/local-hook-outbox.js";
import { lcmHomeDir } from "../runtime-paths.js";
import {
  assertPrivateDirectory,
  openPrivateDirectory,
  type PrivateDirectoryHandle,
  type PrivateDirectoryWitness,
} from "../security-files.js";

function assertStableRoot(
  handle: PrivateDirectoryHandle,
  path: string,
  expected: PrivateDirectoryWitness,
): void {
  const actual = assertPrivateDirectory(handle, path);
  // nlink changes when this operation creates the expected events directory;
  // the descriptor/path identity and ownership/security fields must not.
  if (
    actual.mode !== expected.mode
    || actual.uid !== expected.uid
    || actual.gid !== expected.gid
    || actual.dev !== expected.dev
    || actual.ino !== expected.ino
  ) {
    throw new Error("private directory witness changed");
  }
}
export type LocalHookEnqueueResult = Readonly<{
  inserted: number;
  pendingCount: number;
}>;

/**
 * Append hook events to the durable local SQLite outbox without consulting
 * backend selection, the daemon, or project-map reconciliation. Callers may
 * perform publication-gated work only after this promise resolves.
 */
export async function appendLocalHookEvents(input: Readonly<{
  cwd: string;
  sessionId: string;
  events: readonly LocalHookEvent[];
  sourceHook: string;
}>): Promise<LocalHookEnqueueResult> {
  // EventsDb creates dirname(dbPath) recursively. Authenticate the operator-
  // established root first so a missing ~/.lcm cannot be created as a side
  // effect of hook durability. Keep the descriptor open through the database
  // open while retaining the existing-root guarantee.
  const rootPath = lcmHomeDir();
  const rootHandle = openPrivateDirectory(rootPath);
  const rootWitness = rootHandle.witness;
  const factory = new SQLiteLocalHookOutboxFactory();
  try {
    assertStableRoot(rootHandle, rootPath, rootWitness);
    const db = await factory.open(eventsDbPath(input.cwd));
    try {
      for (const event of input.events) {
        await db.insertEvent(input.sessionId, event, input.sourceHook);
      }
      return {
        inserted: input.events.length,
        pendingCount: (await db.getHealthStats()).unprocessed,
      };
    } finally {
      await factory.close();
    }
  } finally {
    try {
      assertStableRoot(rootHandle, rootPath, rootWitness);
    } finally {
      rootHandle.close();
    }
  }
}
