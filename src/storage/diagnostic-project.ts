import { isAbsolute } from "node:path";
import { normalizeUuidV7 } from "../machine-identity.js";
import { hashProjectPath, normalizeProjectIdentityPath, normalizeProjectPath } from "../project-map.js";

/** Resolve only persisted bindings. This never registers or reconciles a project. */
export function resolveDiagnosticProject(
  content: string | null,
  cwd: string,
  backend: "sqlite" | "postgresql",
): { projectId: string; localProjectId: string } {
  const unavailable = (): never => { throw new Error("Project diagnostic identity is unavailable."); };
  let map: unknown;
  try { map = content === null ? {} : JSON.parse(content); }
  catch { return unavailable(); }
  if (map === null || typeof map !== "object" || Array.isArray(map)) return unavailable();
  const canonical = normalizeProjectIdentityPath(cwd);
  const paths = new Set([canonical, normalizeProjectPath(cwd)]);
  let match: { localProjectId: string; remoteProjectId: string | null } | undefined;
  for (const [id, value] of Object.entries(map)) {
    if (!/^[a-f0-9]{64}$/u.test(id) || value === null || typeof value !== "object" || Array.isArray(value)) return unavailable();
    const entry = value as Record<string, unknown>;
    if (typeof entry.canonical !== "string" || !isAbsolute(entry.canonical)
      || !Array.isArray(entry.aliases)
      || !entry.aliases.every((alias: unknown) => typeof alias === "string" && isAbsolute(alias))) return unavailable();
    const remoteProjectId = typeof entry.remoteProjectId === "string" ? normalizeUuidV7(entry.remoteProjectId) : null;
    if (entry.remoteProjectId !== undefined && remoteProjectId === null) return unavailable();
    if (![entry.canonical, ...entry.aliases as string[]].some(path => paths.has(normalizeProjectPath(path)))) continue;
    if (match !== undefined) return unavailable();
    match = { localProjectId: id, remoteProjectId };
  }
  if (backend === "postgresql") {
    if (match?.remoteProjectId === null || match?.remoteProjectId === undefined) return unavailable();
    return { projectId: match.remoteProjectId, localProjectId: match.localProjectId };
  }
  const id = match?.localProjectId ?? hashProjectPath(canonical);
  return { projectId: id, localProjectId: id };
}
