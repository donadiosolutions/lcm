#!/usr/bin/env node

async function main() {
  const { runCli } = await import("../dist/lcm.mjs");
  await runCli([process.execPath, "/opt/lcm/dist/lcm.mjs", "daemon", "start", "--foreground"]);
}

main().catch((error) => {
  const diagnostics = [];
  const seen = new Set();
  for (let current = error; current && !seen.has(current); current = current.cause) {
    seen.add(current);
    diagnostics.push(String(current?.stack ?? current));
  }
  process.stderr.write(`${diagnostics.join("\nCaused by: ")}\n`);
  process.exitCode = 1;
});
