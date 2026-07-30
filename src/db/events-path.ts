import { join } from "node:path";
import { projectPaths } from "../daemon/project.js";
import { lcmHomeDir } from "../runtime-paths.js";

export function eventsDir(homeDir?: string): string {
  return join(lcmHomeDir(homeDir), "events");
}

export function eventSequenceDbPath(homeDir?: string): string {
  return join(eventsDir(homeDir), ".machine-sequence.sqlite");
}

export function eventsDbPath(cwd: string): string {
  return join(eventsDir(), `${projectPaths(cwd).id}.db`);
}
