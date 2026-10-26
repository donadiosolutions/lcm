#!/usr/bin/env node
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

async function main() {
  const [{ createDaemon }, { loadDaemonConfig }, { ensureAuthToken }] = await Promise.all([
    import(pathToFileURL(join(packageRoot, "dist", "src", "daemon", "server.js")).href),
    import(pathToFileURL(join(packageRoot, "dist", "src", "daemon", "config.js")).href),
    import(pathToFileURL(join(packageRoot, "dist", "src", "daemon", "auth.js")).href),
  ]);
  const lcmHome = join(process.env.HOME, ".lcm");
  const tokenPath = join(lcmHome, "daemon.token");
  const configPath = join(lcmHome, "config.json");
  ensureAuthToken(tokenPath);
  const daemon = await createDaemon(loadDaemonConfig(configPath), {
    tokenPath,
    publicationConfigPath: configPath,
  });
  process.stdout.write(`certification daemon started on port ${daemon.address().port}\n`);
  await new Promise((resolve, reject) => {
    let stopping;
    const stop = () => {
      stopping ??= Promise.resolve(daemon.stop()).then(resolve, reject);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.once("SIGHUP", stop);
  });
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
