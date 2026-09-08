import { withImportCatalogAdmission } from '../../surface-parity/import-admission.mjs';
import { createGitFixture } from '../../surface-parity/git-fixture.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cwdToProjectHash, importSessions } from '../../../dist/src/import.js';
import { EXPORT_VERSION, exportKnowledge, importKnowledge } from '../../../dist/src/portable-knowledge.js';
import { withCliProjectStorage } from '../../../dist/src/cli-storage.js';
import { resolveProjectIdentity } from '../../../dist/src/project-map.js';
import { PrivateMutationLockContentionError } from '../../../dist/src/private-mutation-lock.js';

const SECRET = 'sk-ParityImportCanary01234567890123456789';
const TAG = 'parity-knowledge';
const DIGEST_KEY = 'lcm.portableKnowledge.v1.entryDigests';
const STAMP = '2026-01-02T00:00:00.000Z';

// Failure strings never contain fixture paths, transcript text, or object diffs.
function check(condition, id) {
  if (!condition) throw new Error(`surface-parity-imports:${id}`);
}
function equal(actual, expected, id) {
  check(JSON.stringify(actual) === JSON.stringify(expected), id);
}
function successful(result, id) { check(result.code === 0, id); return result; }
function write(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, value, { mode: 0o600 });
}
// These receipts describe checks implemented below, independently of the manifest.
const EXECUTED_ASSERTIONS = {
  'cli:import': ['arguments', 'result', 'effects'],
  'native-import:claude': ['dispatch', 'result', 'effects'],
  'native-import:codex': ['dispatch', 'result', 'effects'],
  'native-import:all': ['dispatch', 'result', 'effects'],
  'cli:export': ['arguments', 'result', 'effects'],
  'cli:import-knowledge': ['arguments', 'result', 'effects'],
  'knowledge:v1': ['version', 'result', 'effects'],
};
function rows(context, scenario, observations) {
  const owned = context.matrix.filter(row => row.scenario === scenario);
  equal(owned.map(row => row.id).sort(), Object.keys(observations).sort(), 'matrix-ownership');
  return owned.map(row => {
    check(Object.hasOwn(EXECUTED_ASSERTIONS, row.id), 'unimplemented-row');
    const executed = EXECUTED_ASSERTIONS[row.id];
    equal(row.assertions, executed, 'unimplemented-manifest-assertions');
    return { id: row.id, assertions: [...executed], verdict: 'passed', observation: observations[row.id] };
  });
}

function transcript(provider, sessionId, cwd, malformed = false) {
  const messages = [
    { role: 'user', content: `Parity ${provider} orchard question ${SECRET}` },
    { role: 'assistant', content: `Parity ${provider} orchard answer` },
  ];
  const records = provider === 'codex'
    ? [{ timestamp: STAMP, type: 'session_meta', payload: { id: sessionId, cwd } },
      ...messages.map(({ role, content }) => ({ timestamp: STAMP, type: 'response_item', payload: {
        type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: content }],
      } }))]
    : messages.map(({ role, content }, ordinal) => ({ type: role, timestamp: STAMP,
      uuid: `${sessionId}-${ordinal}`, sessionId, cwd, message: { role, content } }));
  return records.map(value => JSON.stringify(value)).join('\n') + '\n'
    + (malformed ? '{"malformed":\n{"truncated":' : '');
}

async function readSession(context, sessionId) {
  return context.readProject(context.projectId, async storage => {
    const conversation = await storage.conversations.getConversationBySessionId(sessionId);
    if (!conversation) return { messages: [], native: [] };
    const messages = await storage.conversations.getMessages(conversation.conversationId);
    check(storage.nativeTranscripts !== undefined, 'native-repository');
    const native = await storage.nativeTranscripts.repository.listByNativeSession({ nativeSessionId: sessionId });
    check(!JSON.stringify({ messages, native }).includes(SECRET), 'native-secret-redaction');
    const checkpoints = await Promise.all(native.slice(0, 1).map(row => storage.nativeTranscripts.repository.getCheckpoint({
      machineId: row.machineId, clientName: row.clientName, sourceLocator: row.sourceLocator,
    })));
    check(checkpoints.length === 1 && checkpoints[0]?.quarantinedCount === 2, 'native-malformed-tail-quarantine');
    return {
      messages: messages.map(row => ({ role: row.role, content: row.content })),
      native: native.map(row => ({ ordinal: row.sourceOrdinal, links: row.messageLinks.length,
        format: row.formatName, version: row.formatVersion })).sort((a, b) => a.ordinal - b.ordinal),
    };
  });
}

async function ensureProjectStorage(context, cwd) {
  const result = await context.request('POST', '/ingest', { cwd, session_id: 'parity-import-prerequisite',
    messages: [{ role: 'user', content: 'Parity import prerequisite storage', tokenCount: 8 }] });
  check(result.status === 200 && [0, 1].includes(result.body.ingested), 'prerequisite-storage');
}


async function nativeImport(context) {
  await ensureProjectStorage(context, context.projectPath);
  // This transport adapter calls the real owned daemon; it does not simulate responses.
  const client = { post: async (path, body) => {
    const result = await context.request('POST', path, body);
    check(result.status === 200, 'native-http-status');
    return result.body;
  } };
  const observations = {};
  const providers = ['claude', 'codex'];
  for (const provider of providers) {
    const sessionId = `parity-native-${provider}`;
    const path = provider === 'claude'
      ? join(context.homeDir, '.claude', 'projects', cwdToProjectHash(context.projectPath), `${sessionId}.jsonl`)
      : join(context.homeDir, '.codex', 'archived_sessions', `${sessionId}.jsonl`);
    write(path, transcript(provider, sessionId, context.projectPath, true));
    const empty = await readSession(context, sessionId);
    equal(empty.messages, [], `${provider}-initial-empty`);
    const dry = successful(await context.cli(['import', '--provider', provider, '--dry-run', '--verbose']), `${provider}-dry-cli`);
    check(dry.stderr.includes('[dry-run] No changes written.'), `${provider}-dry-output`);
    equal(await readSession(context, sessionId), empty, `${provider}-dry-effects`);
    const initial = successful(await context.cli(['import', '--provider', provider, '--verbose']), `${provider}-cli`);
    check(initial.stderr.includes('1 sessions imported (2 messages'), `${provider}-cli-counts`);
    const persisted = await readSession(context, sessionId);
    equal(persisted.messages, [
      { role: 'user', content: `Parity ${provider} orchard question [REDACTED]` },
      { role: 'assistant', content: `Parity ${provider} orchard answer` },
    ], `${provider}-readback`);
    check(persisted.native.length === (provider === 'codex' ? 3 : 2), `${provider}-native-count`);
    check(persisted.native.reduce((n, row) => n + row.links, 0) === 2, `${provider}-native-links`);
    const progress = [];
    const duplicate = await importSessions(client, { cwd: context.projectPath, provider,
      onProgress: patch => progress.push({ completed: patch.completed, total: patch.total }) });
    equal({ imported: duplicate.imported, skipped: duplicate.skippedEmpty, failed: duplicate.failed,
      messages: duplicate.totalMessages, tokens: duplicate.totalTokens },
    { imported: 0, skipped: 1, failed: 0, messages: 0, tokens: 0 }, `${provider}-dedup`);
    equal(progress, [{ completed: 1, total: 1 }], `${provider}-progress`);
    equal(await readSession(context, sessionId), persisted, `${provider}-duplicate-effects`);
    const replay = successful(await context.cli(['import', '--provider', provider, '--replay']), `${provider}-replay`);
    check(replay.stderr.includes('[replay] Sessions compacted sequentially'), `${provider}-replay-output`);
    check(!replay.stderr.includes('compact failed'), `${provider}-replay-compact`);
    equal(await readSession(context, sessionId), persisted, `${provider}-replay-readback`);
    observations[`native-import:${provider}`] = { dryRunUnchanged: true, messages: persisted.messages,
      native: persisted.native, duplicate: { imported: duplicate.imported, skipped: duplicate.skippedEmpty }, progress, replayUnchanged: true };
  }
  const allCurrent = successful(await context.cli(['import', '--provider', 'all']), 'all-current-cli');
  check(allCurrent.stderr.includes('2 skipped (empty transcript)'), 'all-current-counts');
  const allProjects = await importSessions(client, { cwd: context.projectPath, provider: 'all', all: true });
  // Emit only these five bounded numeric counters when all-project discovery differs.
  // Invalid counters use a fixed numeric sentinel; never serialize the import result.
  const allProjectsDiagnostic = Object.fromEntries(
    ['imported', 'skippedEmpty', 'failed', 'unresolved', 'ambiguous'].map(key => [key,
      Number.isSafeInteger(allProjects[key]) && allProjects[key] >= 0 && allProjects[key] <= 1_000_000
        ? allProjects[key] : -1,
    ]),
  );
  equal({ imported: allProjects.imported, skipped: allProjects.skippedEmpty, failed: allProjects.failed,
    unresolved: allProjects.unresolved, ambiguous: allProjects.ambiguous },
  { imported: 0, skipped: 2, failed: 0, unresolved: 0, ambiguous: 0 },
  `all-projects-dedup:i${allProjectsDiagnostic.imported}-s${allProjectsDiagnostic.skippedEmpty}-f${allProjectsDiagnostic.failed}-u${allProjectsDiagnostic.unresolved}-a${allProjectsDiagnostic.ambiguous}`);
  successful(await context.cli(['import', '--provider', 'all', '--all']), 'all-projects-cli');

  // Two real project identities whose Claude directory encoding collides.
  const collisionPaths = [join(context.homeDir, 'import-collision-a'), join(context.homeDir, 'import-collision', 'a')];
  for (const path of collisionPaths) {
    createGitFixture(path, { remote: 'https://example.invalid/parity-import.git' });
    if (context.backend === 'postgresql') successful(await context.cli(['project', 'create', path, '--json']), 'collision-binding');
    else resolveProjectIdentity(path);
    // Native binding ambiguity comes from two real thread-owner metadata records.
    // The resolver checks these owners before its optional Git remote query.
    write(join(path, '.git', 'worktrees', 'parity-owner', 'codex-thread.json'),
      JSON.stringify({ version: 1, ownerThreadId: 'parity-ambiguous' }) + '\n');
  }
  equal(cwdToProjectHash(collisionPaths[0]), cwdToProjectHash(collisionPaths[1]), 'collision-fixture');
  write(join(context.homeDir, '.claude', 'projects', cwdToProjectHash(collisionPaths[0]), 'parity-refused.jsonl'),
    transcript('claude', 'parity-refused', collisionPaths[0]));
  write(join(context.homeDir, '.claude', 'projects', 'parity-unmapped', 'parity-unresolved.jsonl'),
    transcript('claude', 'parity-unresolved', join(context.homeDir, 'absent-project')));
  const codexDir = join(context.homeDir, '.codex');
  mkdirSync(join(codexDir, 'worktrees', 'parity-token'), { recursive: true });
  write(join(codexDir, 'archived_sessions', 'parity-ambiguous.jsonl'), JSON.stringify({ type: 'session_meta',
    payload: { id: 'parity-ambiguous', cwd: join(codexDir, 'worktrees', 'parity-token', 'project'),
      git: { repository_url: 'https://example.invalid/parity-import.git' } } }) + '\n');
  write(join(codexDir, 'archived_sessions', 'parity-unresolved.jsonl'), JSON.stringify({ type: 'session_meta',
    payload: { id: 'parity-unresolved', cwd: join(codexDir, 'deleted', 'project') } }) + '\n');
  const refusals = {};
  for (const provider of providers) {
    const result = await withImportCatalogAdmission(
      () => importSessions(client, { cwd: context.projectPath, provider, all: true }), provider, PrivateMutationLockContentionError,
    );
    const normalized = { unresolved: result.unresolved, ambiguous: result.ambiguous, failed: result.failed, skipped: result.skippedEmpty };
    equal(normalized, { unresolved: 1, ambiguous: 1, failed: provider === 'claude' ? 2 : 0, skipped: 1 }, `${provider}-refusals`);
    const cli = await context.cli(['import', '--provider', provider, '--all', '--verbose']);
    check(cli.code === (provider === 'claude' ? 1 : 0), `${provider}-refusal-exit`);
    check(cli.stderr.includes('sessions unresolved') && cli.stderr.includes('sessions ambiguous'), `${provider}-refusal-diagnostics`);
    const dry = await importSessions(client, { cwd: context.projectPath, provider, all: true, dryRun: true });
    equal({ unresolved: dry.unresolved, ambiguous: dry.ambiguous, failed: dry.failed },
      { unresolved: 1, ambiguous: 1, failed: provider === 'claude' ? 2 : 0 }, `${provider}-dry-refusals`);
    equal((await readSession(context, 'parity-unresolved')).messages, [], `${provider}-unresolved-no-write`);
    equal((await readSession(context, 'parity-refused')).messages, [], `${provider}-ambiguous-no-write`);
    refusals[provider] = normalized;
  }
  const invalid = await context.cli(['import', '--provider', 'invalid-provider']);
  check(invalid.code === 1 && invalid.stderr.includes('Unknown provider'), 'invalid-provider');
  observations['native-import:all'] = { currentAndAllProjects: { imported: 0, skipped: 2 }, refusals };
  observations['cli:import'] = { providers: providers.length + 1, invalidProviderExit: invalid.code, refusals };
  return rows(context, 'native-import', observations);
}

async function knowledgeRows(cwd) {
  return withCliProjectStorage(cwd, { create: false }, async ({ storage }) =>
    (await storage.promotedMemory.getAll({ tags: [TAG] })).map(row => ({
      id: row.id, content: row.content, tags: row.tags, confidence: row.confidence,
      sessionId: row.sessionId, projectId: row.projectId, metadata: row.metadata,
    })).sort((a, b) => a.content.localeCompare(b.content)));
}
function normalizedEntries(doc) {
  equal(Object.keys(doc).sort(), ['entries', 'exportedAt', 'projectCwd', 'version'], 'v1-document-fields');
  check(doc.version === 1 && Number.isFinite(Date.parse(doc.exportedAt)), 'v1-header');
  for (const entry of doc.entries) {
    equal(Object.keys(entry).sort(), ['confidence', 'content', 'createdAt', 'sessionId', 'tags'], 'v1-entry-fields');
    check(Number.isFinite(Date.parse(entry.createdAt)) && entry.sessionId === null, 'v1-export-provenance');
    check(!JSON.stringify(entry).includes(SECRET) && !JSON.stringify(entry).includes(DIGEST_KEY), 'v1-redaction');
  }
  return doc.entries.map(({ createdAt, ...entry }) => entry).sort((a, b) => a.content.localeCompare(b.content));
}

async function knowledge(context) {
  await ensureProjectStorage(context, context.projectPath);
  await ensureProjectStorage(context, context.secondaryProjectPath);
  check(EXPORT_VERSION === 1, 'v1-constant');
  const source = { version: 1, exportedAt: STAMP, projectCwd: '/parity/knowledge-source', entries: [
    { content: `Orchard pruning schedule ${SECRET}`, tags: [TAG, 'gardening', SECRET], confidence: 0.8, createdAt: STAMP, sessionId: 'parity-source-session' },
    { content: 'Ceramic kiln temperature guidance', tags: [TAG, 'pottery'], confidence: 0.6, createdAt: STAMP, sessionId: null },
  ] };
  const file = join(context.homeDir, 'parity-knowledge-input.json');
  write(file, JSON.stringify(source));
  const before = await knowledgeRows(context.projectPath);
  equal(before, [], 'knowledge-fixture-empty');
  const dryCli = successful(await context.cli(['import-knowledge', file, '--dry-run']), 'knowledge-dry-cli');
  check(dryCli.stderr.includes('2 valid, 0 skipped. No changes written.'), 'knowledge-dry-output');
  equal(await importKnowledge(context.projectPath, source, { dryRun: true }),
    { total: 2, imported: 0, skipped: 0, dryRun: true }, 'knowledge-dry-library');
  equal(await knowledgeRows(context.projectPath), before, 'knowledge-dry-no-writes');
  const imported = successful(await context.cli(['import-knowledge', file, '--merge']), 'knowledge-import-cli');
  check(imported.stderr.includes('Imported 2 entries (0 skipped)'), 'knowledge-import-counts');
  const stored = await knowledgeRows(context.projectPath);
  check(stored.length === 2, 'knowledge-stored-count');
  for (const entry of stored) {
    check(!JSON.stringify(entry).includes(SECRET), 'knowledge-import-scrub');
    const digests = entry.metadata[DIGEST_KEY];
    check(Array.isArray(digests) && digests.length === 1 && /^[a-f0-9]{64}$/u.test(digests[0]), 'knowledge-retry-digest');
    check(entry.projectId === (context.backend === 'postgresql' ? context.remoteProjectId : context.projectId), 'knowledge-owner-provenance');
  }
  check(stored.find(entry => entry.content.startsWith('Orchard')).sessionId === 'parity-source-session', 'knowledge-session-provenance');
  const retry = await importKnowledge(context.projectPath, source);
  equal(retry, { total: 2, imported: 0, skipped: 2, dryRun: false }, 'knowledge-library-retry');
  const retryCli = successful(await context.cli(['import-knowledge', file]), 'knowledge-retry-cli');
  check(retryCli.stderr.includes('Imported 0 entries (2 skipped)'), 'knowledge-retry-output');
  equal(await knowledgeRows(context.projectPath), stored, 'knowledge-retry-no-writes');

  const output = join(context.homeDir, 'parity-knowledge-export.json');
  const exported = successful(await context.cli(['export', '--tags', TAG, '--output', output, '--format', 'json']), 'knowledge-export-cli');
  check(exported.stderr.includes('Exported 2 entries'), 'knowledge-export-counts');
  const doc = JSON.parse(readFileSync(output, 'utf8'));
  check(doc.projectCwd === context.projectPath, 'knowledge-export-project');
  const entries = normalizedEntries(doc);
  equal(entries, [
    { content: 'Ceramic kiln temperature guidance', tags: [TAG, 'pottery'], confidence: 0.6, sessionId: null },
    { content: 'Orchard pruning schedule [REDACTED]', tags: [TAG, 'gardening', '[REDACTED]'], confidence: 0.8, sessionId: null },
  ], 'knowledge-export-values');
  const libraryOutput = join(context.homeDir, 'parity-knowledge-library.json');
  const libraryResult = await exportKnowledge(context.projectPath, { tags: [TAG], output: libraryOutput });
  equal(libraryResult, { exported: 2, projectCwd: context.projectPath }, 'knowledge-export-library-result');
  equal(normalizedEntries(JSON.parse(readFileSync(libraryOutput, 'utf8'))), entries, 'knowledge-export-library-values');
  await exportKnowledge(context.projectPath, { tags: [TAG], output: libraryOutput, _globalPatterns: ['Orchard'] });
  const scrubbedExport = normalizedEntries(JSON.parse(readFileSync(libraryOutput, 'utf8')));
  check(scrubbedExport.some(entry => entry.content === '[REDACTED] pruning schedule [REDACTED]'), 'knowledge-export-applies-scrub');
  equal(await knowledgeRows(context.projectPath), stored, 'knowledge-export-no-mutations');
  const filtered = successful(await context.cli(['export', '--tags', 'pottery', '--since', '2026-01-01']), 'knowledge-filter-cli');
  equal(normalizedEntries(JSON.parse(filtered.stdout)), [entries[0]], 'knowledge-filter-values');

  const destinationBefore = await knowledgeRows(context.secondaryProjectPath);
  equal(destinationBefore, [], 'knowledge-destination-empty');
  const destinationImport = successful(await context.cli(['import-knowledge', output, '--confidence', '0.7'], { cwd: context.secondaryProjectPath }), 'knowledge-destination-cli');
  check(destinationImport.stderr.includes('Imported 2 entries (0 skipped)'), 'knowledge-destination-counts');
  const destination = await knowledgeRows(context.secondaryProjectPath);
  equal(destination.map(({ content, tags }) => ({ content, tags })), entries.map(({ content, tags }) => ({ content, tags })), 'knowledge-destination-content');
  check(destination.length === 2 && destination.every(row => row.confidence === 0.7 && row.sessionId === null), 'knowledge-destination-values');
  check(destination.every(row => row.projectId !== stored[0].projectId), 'knowledge-destination-owner');
  equal(await importKnowledge(context.secondaryProjectPath, doc, { confidence: 0.7 }),
    { total: 2, imported: 0, skipped: 2, dryRun: false }, 'knowledge-destination-retry');
  equal(await knowledgeRows(context.projectPath), stored, 'knowledge-source-unchanged');

  write(file, JSON.stringify({ ...source, version: 2 }));
  const invalid = await context.cli(['import-knowledge', file]);
  check(invalid.code === 1, 'knowledge-invalid-version-cli');
  let rejected = false;
  try { await importKnowledge(context.projectPath, { ...source, version: 2 }); }
  catch (error) { rejected = error instanceof Error && error.message === 'Unsupported export version (expected 1)'; }
  check(rejected, 'knowledge-invalid-version-library');
  equal(await knowledgeRows(context.projectPath), stored, 'knowledge-invalid-no-write');
  check((await context.cli(['export', '--format', 'yaml'])).code === 1, 'knowledge-invalid-format');
  check((await context.cli(['import-knowledge', output, '--confidence', '2'])).code === 1, 'knowledge-invalid-confidence');
  const observation = { version: EXPORT_VERSION, entries, retry, sourceUnchanged: true,
    destination: destination.map(row => ({ content: row.content, tags: row.tags, confidence: row.confidence, sessionId: row.sessionId })),
    invalidVersionExit: invalid.code };
  return rows(context, 'knowledge', { 'cli:export': observation, 'cli:import-knowledge': observation, 'knowledge:v1': observation });
}

export async function runImportScenario(scenario, context) {
  if (scenario === 'native-import') return nativeImport(context);
  if (scenario === 'knowledge') return knowledge(context);
  throw new Error('surface-parity-imports:unknown-scenario');
}
