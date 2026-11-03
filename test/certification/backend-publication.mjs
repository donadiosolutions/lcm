import { join } from "node:path";
import { pathToFileURL } from "node:url";

function targetConfig(source) {
  if (source.presence !== "present") {
    throw new Error("certification backend publication requires an existing private config");
  }
  const parsed = JSON.parse(source.content.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || (parsed.storage !== undefined && (typeof parsed.storage !== "object" || Array.isArray(parsed.storage)))) {
    throw new Error("certification backend publication source config is invalid");
  }
  return {
    ...source,
    content: Buffer.from(`${JSON.stringify({
      ...parsed,
      storage: { ...(parsed.storage ?? {}), backend: "postgresql" },
    }, null, 2)}\n`),
  };
}

async function productionDependencies(packageRoot) {
  const material = await import(pathToFileURL(join(packageRoot, "dist", "src", "storage", "backend-publication-material.js")).href);
  const driver = await import(pathToFileURL(join(packageRoot, "dist", "src", "storage", "backend-publication-driver.js")).href);
  return {
    captureSource: material.captureBackendPublicationSourceMaterial,
    createCoordinator: driver.createBackendPublicationCoordinator,
  };
}

export async function publishPostgreSqlBackend(input, dependencies) {
  const resolved = dependencies ?? await productionDependencies(input.packageRoot);
  const source = resolved.captureSource({ homeDir: input.homeDir });
  const coordinator = resolved.createCoordinator({
    homeDir: input.homeDir,
    remoteGuard: { mode: "absent", acknowledged: true },
  });
  await coordinator.prepare({
    publicationId: input.publicationId,
    sourceBackend: "sqlite",
    targetBackend: "postgresql",
    material: {
      source,
      target: { config: targetConfig(source.config), projectMap: source.projectMap },
    },
    projects: [],
  });
  const completed = await coordinator.resume();
  if (completed.phase !== "completed") {
    throw new Error(`certification backend publication stopped at ${completed.phase}`);
  }
  return completed;
}
