import { join } from "node:path";
import { projectPaths } from "../daemon/project.js";
import { lcmHomeDir } from "../runtime-paths.js";

export function eventsDir(): string {
  return join(lcmHomeDir(), "events");
}

export function eventsDbPath(cwd: string): string {
  return join(eventsDir(), `${projectPaths(cwd).id}.db`);
}
