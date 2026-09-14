// The public import still executes once admitted; this fixture-only helper
// retries only the real private catalog-admission contention class.
export async function withImportCatalogAdmission(operation, provider, ContentionError) {
  if (provider !== 'claude' && provider !== 'codex') throw new Error('surface-parity-imports:admission-provider');
  // Preserve the bounded contention failure while identifying its source.
  // Only fixed module names and line numbers may enter public evidence.
  const deadline = Date.now() + 5000;
  for (;;) {
    try { return await operation(); }
    catch (error) {
      if (!(error instanceof ContentionError)) throw error;
      if (Date.now() >= deadline) {
        const stack = String(error.stack ?? '');
        const frame = stack.match(/\/(?:dist\/)?src\/(import|cli-storage|project-map|worktree-reconciliation|codex-project-resolution|git-project|identity-service|storage\/(?:backend-publication|publication-convergence))\.(?:js|ts):(\d+):\d+/u)
          ?? stack.match(/\/(?:dist\/)?src\/(private-mutation-lock)\.(?:js|ts):(\d+):\d+/u);
        const source = frame ? `${frame[1]}.${frame[2]}` : 'unknown-source';
        throw new Error(`surface-parity-imports:${provider}-contention:${source}`, { cause: error });
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}
