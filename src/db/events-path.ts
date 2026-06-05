import { join } from "node:path";
import { projectId } from "../daemon/project.js";
import { lcmHomeDir } from "../runtime-paths.js";

export function eventsDir(): string {
  return join(lcmHomeDir(), "events");
}

export function eventsDbPath(cwd: string): string {
  return join(eventsDir(), `${projectId(cwd)}.db`);
}
