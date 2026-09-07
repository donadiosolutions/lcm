/**
 * Only the process regression's lifecycle/configuration boundary is simulated.
 * CLI dispatch, the hook, HTTP/authentication and publication fences stay real.
 * The canonical real-daemon certificate is a separate integration check.
 */
export function loadHookConfig() {
  return { daemonPort: Number(process.env.LCM_TEST_COMPLETION_PORT), storage: { backend: "sqlite" } };
}

export function loadDaemonConfig() {
  return { hooks: { disableAutoCompact: false }, security: { notify_on_filter: false } };
}

export async function ensureDaemon(options: { port: number }) {
  return { connected: true, spawned: false, port: options.port };
}

export async function ensureBootstrapped() { return true; }
export async function ensureCoreEndpoint() { throw new Error("Unexpected endpoint bootstrap in SessionEnd fixture"); }
export function validateAndFixHooks() {}
