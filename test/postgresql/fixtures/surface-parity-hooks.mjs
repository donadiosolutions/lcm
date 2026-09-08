import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createGitFixture } from '../../surface-parity/git-fixture.mjs';

const HOOKS = ['restore', 'session-end', 'user-prompt', 'post-tool', 'session-snapshot'];
const INSTRUCTION = 'Parity hook instruction: preserve the orchard watering schedule.';
const NEEDLE = 'quince espalier pollination orchard';

function executedAssertions(id) {
  if (id.startsWith('cli:')) return ['arguments', 'result', 'effects'];
  if (id.startsWith('daemon:')) return ['admission', 'result', 'effects'];
  assert.fail(`surface-parity:unknown-assertion-kind:${id}`);
}

function record(context, id, observation) {
  const row = context.matrix.find(entry => entry.id === id);
  assert.ok(row, `surface-parity:unknown-row:${id}`);
  const assertions = executedAssertions(id);
  assert.deepEqual(row.assertions, assertions, `surface-parity:unexecuted-assertion:${id}`);
  return { id, assertions, verdict: 'passed', observation };
}

async function hook(context, command, payload) {
  const result = await context.cli([command, '--client', 'claude'], {
    cwd: context.projectPath, stdin: JSON.stringify(payload),
  });
  const failureClass = ['contention', 'publication', 'daemon', 'database', 'SQLITE', 'bootstrap'].filter(term => result.stderr.includes(term)).join('-') || 'unclassified';
  assert.equal(result.code, 0, `surface-parity:${command}:exit-${result.code}-${failureClass}`);
  return result;
}

async function post(context, path, body, status = 200) {
  const response = await context.request('POST', path, body);
  assert.equal(response.status, status, `surface-parity:${path}:status`);
  return response.body;
}

function transcript(context, sessionId, contents) {
  const path = join(context.projectPath, `${sessionId}.jsonl`);
  writeFileSync(path, contents.map((content, index) => JSON.stringify({
    type: index % 2 ? 'assistant' : 'user',
    uuid: `${sessionId}-${index}`, sessionId,
    message: { role: index % 2 ? 'assistant' : 'user', content },
  })).join('\n') + '\n', { mode: 0o600 });
  return { session_id: sessionId, cwd: context.projectPath, transcript_path: path, client: 'claude' };
}

async function messages(context, sessionId) {
  return context.readProject(context.projectId, async storage => {
    const conversation = await storage.conversations.getConversationBySessionId(sessionId);
    assert.ok(conversation, 'surface-parity:hook:conversation-persisted');
    return storage.conversations.getMessages(conversation.conversationId);
  });
}

async function memories(context) {
  return context.readProject(context.projectId, storage => storage.promotedMemory.getAll());
}

async function localEvents(context, sessionId) {
  // Native read-only observation of the documented SQLite hook outbox. This
  // is deliberately outside project storage, including in the PostgreSQL leg.
  const { existingEventsDbPath } = await import('../../../dist/src/db/events-path.js');
  const path = existingEventsDbPath(context.projectPath);
  assert.ok(path && existsSync(path), 'surface-parity:hook:local-outbox-exists');
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare('SELECT type, category, data, priority, source_hook, processed_at FROM events WHERE session_id = ? ORDER BY seq').all(sessionId);
  } finally { database.close(); }
}

async function waitFor(check, assertionId) {
  const deadline = Date.now() + 5000;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.fail(`surface-parity:${assertionId}`);
}

async function runHooks(context) {
  const observations = [];
  for (const command of HOOKS) {
    const invalid = await context.cli([command, '--surface-parity-invalid'], { stdin: '{}' });
    assert.notEqual(invalid.code, 0, `surface-parity:${command}:arguments`);
    assert.equal(invalid.stdout, '', `surface-parity:${command}:invalid-stdout`);
    assert.match(invalid.stderr, /unknown option.*--surface-parity-invalid/, `surface-parity:${command}:invalid-diagnostic`);
  }

  mkdirSync(join(context.projectPath, '.claude'), { recursive: true, mode: 0o700 });
  writeFileSync(join(context.projectPath, '.claude', 'CLAUDE.md'), INSTRUCTION + '\n', { mode: 0o600 });
  await post(context, '/restore', { cwd: context.projectPath }, 400);
  const restored = await post(context, '/restore', {
    cwd: context.projectPath, session_id: 'parity-restore-route', client: 'claude',
  });
  assert.ok(restored.context.includes(INSTRUCTION), 'surface-parity:restore:instruction-output');
  const restoredScope = await context.readProject(context.projectId, storage => storage.coordination.getSessionInstructions({
    clientName: 'claude', sessionId: 'parity-restore-route',
    worktreePath: context.projectPath, cwdPath: context.projectPath,
  }));
  assert.ok(restoredScope?.content.includes(INSTRUCTION), 'surface-parity:restore:instruction-cache');

  const restoreHadPending = await context.hasPendingPassiveWork();
  const restoreCli = await hook(context, 'restore', { cwd: context.projectPath, session_id: 'parity-restore-cli' });
  assert.ok(restoreCli.stdout.includes(INSTRUCTION), 'surface-parity:restore:native-output');
  const cliScope = await context.readProject(context.projectId, storage => storage.coordination.getSessionInstructions({
    clientName: 'claude', sessionId: 'parity-restore-cli', worktreePath: context.projectPath, cwdPath: context.projectPath,
  }));
  assert.ok(cliScope?.content.includes(INSTRUCTION), 'surface-parity:restore:native-cache');
  observations.push(record(context, 'cli:restore', { exit: restoreCli.code, instructionReturned: true, instructionPersisted: true, outbox: 'sqlite-local' }));
  if (restoreHadPending) await context.isolateAsyncWork();

  const ingestInput = transcript(context, 'parity-ingest-route', ['Durable pear cultivation context.', 'Keep root pruning records.']);
  await post(context, '/ingest', {}, 400);
  const ingested = await post(context, '/ingest', ingestInput);
  assert.equal(ingested.ingested, 2, 'surface-parity:ingest:result');
  const ingestMessages = await messages(context, ingestInput.session_id);
  assert.deepEqual(ingestMessages.map(message => message.content), ['Durable pear cultivation context.', 'Keep root pruning records.']);
  const replay = await post(context, '/ingest', ingestInput);
  assert.equal(replay.ingested, 0, 'surface-parity:ingest:replay');

  const snapshot = transcript(context, 'parity-snapshot-cli', ['Snapshot preserves the pear nursery.', 'Snapshot also preserves cultivar notes.']);
  const snapshotResult = await hook(context, 'session-snapshot', snapshot);
  assert.equal(snapshotResult.stdout, '', 'surface-parity:snapshot:stdout');
  assert.equal((await messages(context, snapshot.session_id)).length, 2);
  const cursorPath = join(context.homeDir, '.lcm/tmp', `snap-${snapshot.session_id}.json`);
  const cursorWitness = () => {
    const stat = lstatSync(cursorPath);
    assert.ok(stat.isFile(), 'surface-parity:snapshot:cursor-file');
    return { inode: stat.ino, dev: stat.dev, mtime: stat.mtimeMs, content: readFileSync(cursorPath, 'utf8') };
  };
  const originalCursor = cursorWitness();
  await context.isolateAsyncWork();
  // Preserve both contracts: the durable throttle survives restart, and two
  // successful repeats in that fresh daemon lifetime remain duplicate-free.
  await hook(context, 'session-snapshot', snapshot);
  const snapshotMessages = await messages(context, snapshot.session_id);
  assert.equal(snapshotMessages.length, 2, 'surface-parity:snapshot:idempotent');
  assert.ok(JSON.stringify(cursorWitness()) === JSON.stringify(originalCursor), 'surface-parity:snapshot:restart-cursor');
  const expectedLifetime = context.currentDaemonIdentity();
  const duplicateLifetime = await context.client.observe();
  assert.equal(duplicateLifetime?.pid, expectedLifetime.pid, 'surface-parity:snapshot:duplicate-pid');
  assert.equal(duplicateLifetime?.daemonInstanceId, expectedLifetime.generation, 'surface-parity:snapshot:duplicate-generation');
  await hook(context, 'session-snapshot', snapshot);
  assert.equal((await messages(context, snapshot.session_id)).length, 2, 'surface-parity:snapshot:same-lifetime-idempotent');
  assert.ok(JSON.stringify(cursorWitness()) === JSON.stringify(originalCursor), 'surface-parity:snapshot:same-lifetime-cursor');
  const repeatedLifetime = await context.client.observe();
  assert.equal(repeatedLifetime?.pid, duplicateLifetime.pid, 'surface-parity:snapshot:repeat-pid');
  assert.equal(repeatedLifetime?.daemonInstanceId, duplicateLifetime.daemonInstanceId, 'surface-parity:snapshot:repeat-generation');
  observations.push(record(context, 'cli:session-snapshot', { exit: snapshotResult.code, persisted: snapshotMessages.length, duplicateFree: true, outbox: 'sqlite-local' }));
  await context.isolateAsyncWork();


  await post(context, '/session-complete', {}, 400);
  const completion = await post(context, '/session-complete', { ...ingestInput, message_count: 9999 });
  assert.equal(completion.recorded, true);
  const completed = await context.readProject(context.projectId, storage => storage.coordination.getSessionIngest(ingestInput.session_id));
  assert.equal(completed.messageCount, 2, 'surface-parity:session-complete:authoritative-count');

  const ending = transcript(context, 'parity-session-end-cli', ['Session end retains grafting records.', 'Protect the nursery from frost.']);
  const endResult = await hook(context, 'session-end', ending);
  assert.equal(endResult.stdout, '', 'surface-parity:session-end:stdout');
  assert.equal((await messages(context, ending.session_id)).length, 2);
  let completionCount = 'missing';
  try {
    await waitFor(async () => {
      const row = await context.readProject(context.projectId, storage => storage.coordination.getSessionIngest(ending.session_id));
      completionCount = row === null ? 'missing' : String(row.messageCount);
      return row?.messageCount === 2;
    }, 'session-end:completion-persisted');
  } catch { assert.fail(`surface-parity:session-end:completion-${completionCount}`); }
  observations.push(record(context, 'cli:session-end', { exit: endResult.code, persisted: 2, completionRecorded: true, outbox: 'sqlite-local' }));
  await context.isolateAsyncWork();

  const capture = await hook(context, 'post-tool', {
    cwd: context.projectPath, session_id: 'parity-post-tool-cli', tool_name: 'Read',
    tool_input: { file_path: 'pear-nursery.ts' }, tool_response: 'Read completed.',
  });
  assert.equal(capture.stdout, '');
  const captured = await localEvents(context, 'parity-post-tool-cli');
  assert.equal(captured.length, 1);
  const { processed_at: _processedAt, ...capturedEvent } = captured[0];
  assert.deepEqual(capturedEvent, {
    type: 'file_read', category: 'file', data: 'pear-nursery.ts (source)',
    priority: 3, source_hook: 'PostToolUse',
  });
  observations.push(record(context, 'cli:post-tool', { exit: capture.code, events: captured.length, priority: captured[0].priority, outbox: 'sqlite-local' }));

  // The production prompt-search minimum score is 2. A one-document FTS
  // corpus gives every term near-zero inverse document frequency, so retain
  // unrelated real memories to exercise the normal relevance gate unchanged.
  for (const text of [
    'Copper telescope spectrometry calibration', 'Indigo pottery kiln temperature',
    'Silver violin bowing articulation', 'Basalt tidal turbine maintenance',
  ]) await post(context, '/store', { cwd: context.projectPath, text, tags: ['parity-hook-background'] });
  const stored = await post(context, '/store', { cwd: context.projectPath, text: NEEDLE, tags: ['parity-hook-recall'] });
  assert.equal(stored.stored, true);
  const invalidSearch = await post(context, '/prompt-search', {});
  assert.deepEqual(invalidSearch, { hints: [] });
  const promptSearch = await post(context, '/prompt-search', {
    cwd: context.projectPath, session_id: 'parity-prompt-route', query: NEEDLE, logSurfacing: false,
  });
  assert.ok(promptSearch.ids.includes(stored.id), 'surface-parity:prompt-search:matched-id');
  assert.ok(promptSearch.hints.some(hint => hint.includes(NEEDLE)), 'surface-parity:prompt-search:matched-text');

  const prompt = `Always preserve ${NEEDLE}`;
  const prompted = await hook(context, 'user-prompt', { cwd: context.projectPath, session_id: 'parity-user-prompt-cli', prompt });
  assert.ok(prompted.stdout.includes(NEEDLE), 'surface-parity:user-prompt:recalled-context');
  const promptEvents = await localEvents(context, 'parity-user-prompt-cli');
  assert.ok(promptEvents.some(event => event.type === 'user_decision' && event.priority === 1 && event.data === prompt));
  const feedback = await context.readProject(context.projectId, storage => storage.recall.getFeedback([stored.id]));
  assert.ok(feedback.get(stored.id)?.surfacingCount > 0, 'surface-parity:user-prompt:surfacing-recorded');
  observations.push(record(context, 'cli:user-prompt', { exit: prompted.code, recalledContext: true, decisionCaptured: true, surfacingRecorded: true, outbox: 'sqlite-local' }));
  await context.isolateAsyncWork();

  return observations;
}

/** Also used by the compaction owner; its sole row remains cli:compact. */
export async function runCompactHook(context) {
  const input = transcript(context, 'parity-compact-hook', Array.from({ length: 16 }, (_, index) =>
    `Orchard architecture decision ${index}: retain the perennial grafting schedule. ${'Cultivar pruning context. '.repeat(20)}`));
  const result = await context.cli(['compact', '--hook', '--client', 'claude'], { cwd: context.projectPath, stdin: JSON.stringify(input) });
  assert.equal(result.code, 0, 'surface-parity:compact-hook:exit');
  const summaries = await context.readProject(context.projectId, async storage => {
    const conversation = await storage.conversations.getConversationBySessionId(input.session_id);
    assert.ok(conversation, 'surface-parity:compact-hook:ingested');
    return storage.summaries.getSummariesByConversation(conversation.conversationId);
  });
  assert.ok(summaries.length > 0, 'surface-parity:compact-hook:summaries');
  assert.ok(result.stdout.includes('compaction-summary'), 'surface-parity:compact-hook:stdout');
  await context.isolateAsyncWork();
  return { exit: result.code, summariesPersisted: true, summaryReturned: true };
}

async function promotionContext(original) {
  // Promotion scans every conversation in its project. Keep this corpus
  // separate so earlier mock summaries cannot deduplicate into a memory whose
  // session belongs to another scenario, obscuring ordinary source provenance.
  const projectPath = join(dirname(original.projectPath), 'surface-promotion');
  assert.equal(existsSync(projectPath), false, 'surface-parity:promotion:fresh-project');
  createGitFixture(projectPath);
  const { hashProjectPath } = await import('../../../dist/src/project-map.js');
  const projectId = hashProjectPath(projectPath);
  assert.notEqual(projectId, original.projectId, 'surface-parity:promotion:separate-project');
  let remoteProjectId;
  if (original.backend === 'postgresql') {
    const result = await original.cli(['project', 'create', projectPath, '--json'], { cwd: projectPath });
    assert.equal(result.code, 0, 'surface-parity:promotion:project-create');
    const created = JSON.parse(result.stdout);
    remoteProjectId = created.remote.projectId;
    assert.match(remoteProjectId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu, 'surface-parity:promotion:remote-project');
    assert.equal(created.local.id, projectId, 'surface-parity:promotion:local-project');
    assert.equal(created.local.remoteProjectId, remoteProjectId, 'surface-parity:promotion:project-binding');
    assert.notEqual(remoteProjectId, projectId, 'surface-parity:promotion:distinct-provenance');
  }
  // SQLite creates its persisted identity through the real /ingest below.
  // Backend selection, HOME, daemon and read-only observers remain unchanged.
  return { ...original, projectPath, projectId, remoteProjectId };
}

async function runPromotion(originalContext) {
  const context = await promotionContext(originalContext);
  const invalid = await context.cli(['promote', '--surface-parity-invalid'], { cwd: context.projectPath });
  assert.notEqual(invalid.code, 0, 'surface-parity:promote:arguments');
  assert.equal(invalid.stdout, '', 'surface-parity:promote:invalid-stdout');
  assert.match(invalid.stderr, /unknown option.*--surface-parity-invalid/, 'surface-parity:promote:invalid-diagnostic');
  await post(context, '/promote', {}, 400);
  const source = transcript(context, 'parity-normal-promotion', Array.from({ length: 16 }, (_, index) =>
    `Orchard architecture decision ${index}: preserve perennial rootstock. ${'Stable grafting and pruning constraints. '.repeat(20)}`));
  const ingest = await post(context, '/ingest', source);
  assert.equal(ingest.ingested, 16);
  const compacted = await post(context, '/compact', { ...source, skip_ingest: true });
  assert.equal(compacted.actionTaken, true, 'surface-parity:promotion:normal-compaction');
  const before = await memories(context);
  const deniedPromote = await context.request('POST', '/promote', { cwd: context.projectPath }, { auth: false });
  assert.equal(deniedPromote.status, 401, 'surface-parity:promote:authentication');
  assert.deepEqual(deniedPromote.body, { error: 'unauthorized' }, 'surface-parity:promote:authentication-result');
  assert.deepEqual(await memories(context), before, 'surface-parity:promote:authentication-no-writes');
  const preview = await context.cli(['promote', '--dry-run', '--verbose'], { cwd: context.projectPath });
  assert.equal(preview.code, 0, 'surface-parity:promote:preview-exit');
  assert.equal(preview.stdout, '', 'surface-parity:promote:preview-stdout');
  assert.match(preview.stderr, /\[dry-run\] No changes will be written/);
  assert.match(preview.stderr, /\[dry-run\] No changes written/);
  assert.match(preview.stderr, /\d+ summaries scanned across 1 project/);
  assert.deepEqual(await memories(context), before, 'surface-parity:promote:dry-run-no-writes');
  const promoted = await context.cli(['promote', '--verbose'], { cwd: context.projectPath });
  assert.equal(promoted.code, 0, 'surface-parity:promote:exit');
  assert.equal(promoted.stdout, '', 'surface-parity:promote:stdout');
  assert.match(promoted.stderr, /\d+ insights? promoted to long-term memory/);
  assert.match(promoted.stderr, /\d+ summaries scanned across 1 project/);
  const ordinary = (await memories(context)).filter(memory => memory.sessionId === source.session_id);
  assert.ok(ordinary.length > 0, 'surface-parity:promote:ordinary-memory');
  for (const memory of ordinary) assert.equal(memory.projectId, context.projectId, 'surface-parity:promote:ordinary-local-provenance');
  const repeated = await post(context, '/promote', { cwd: context.projectPath });
  assert.equal(repeated.promoted, 0, 'surface-parity:promote:idempotence');
  const target = ordinary[0];
  // Preserve ordinary route provenance. Exactly ONE priority-three event must
  // reinforce the same memory, without invoking the repeated-evidence branch.
  const { appendLocalHookEvents } = await import('../../../dist/src/hooks/local-enqueue.js');
  const enqueue = await appendLocalHookEvents({
    cwd: context.projectPath, sessionId: 'parity-single-passive-match', sourceHook: 'PostToolUse',
    events: [{ type: 'file', category: 'file', data: target.content, priority: 3 }],
  });
  assert.equal(enqueue.inserted, 1, 'surface-parity:promotion:single-event');
  const drained = await post(context, '/promote-events', { cwd: context.projectPath, drain: true });
  assert.equal(drained.errors, 0, 'surface-parity:promotion:single-event-errors');
  const reinforced = (await memories(context)).find(memory => memory.id === target.id);
  assert.ok(reinforced?.tags.includes('source:passive-capture'), 'surface-parity:promotion:ordinary-provenance-reinforced-1158');
  assert.equal(reinforced.projectId, context.projectId, 'surface-parity:promotion:provenance-retained');
  assert.equal((await memories(context)).filter(memory => memory.content === target.content).length, 1, 'surface-parity:promotion:same-memory');

  // Independent tier-one and tier-two inputs must promote without waiting
  // for repeated observations. These use the actual native hook transport.
  await hook(context, 'post-tool', {
    cwd: context.projectPath, session_id: 'parity-tier-one', tool_name: 'AskUserQuestion',
    tool_input: { question: 'Which greenhouse glazing?' }, tool_response: 'Borosilicate panes',
  });
  await hook(context, 'post-tool', {
    cwd: context.projectPath, session_id: 'parity-tier-two', tool_name: 'Bash',
    tool_input: { command: 'git commit -m "greenhouse glazing"' }, tool_response: 'Committed',
  });
  const tiers = await post(context, '/promote-events', { cwd: context.projectPath, drain: true });
  assert.equal(tiers.errors, 0, 'surface-parity:promotion:tier-errors');
  const tierMemories = await memories(context);
  assert.ok(tierMemories.some(memory => memory.content === 'Q: Which greenhouse glazing?\nA: Borosilicate panes'));
  assert.ok(tierMemories.some(memory => memory.content === 'git commit: greenhouse glazing'));

  // A skill name is one isolated lexeme: a file event's '(source)' suffix
  // would already match the source:passive-capture tags from earlier tiers.
  const patternContent = 'xylophoniczirconiumlattice';
  const capturePattern = session_id => hook(context, 'post-tool', {
    cwd: context.projectPath, session_id, tool_name: 'Skill',
    tool_input: { skill: patternContent }, tool_response: 'Skill completed',
  });
  // Two identical observations in one session are insufficient. The third
  // observation in a second session is the first bootstrap-eligible state.
  for (let index = 0; index < 2; index++) {
    await capturePattern('parity-pattern-first');
    const drain = await post(context, '/promote-events', { cwd: context.projectPath, drain: true });
    assert.equal(drain.errors, 0);
    assert.equal((await memories(context)).filter(memory => memory.content === patternContent).length, 0, 'surface-parity:promotion:pattern-before-threshold');
  }
  await capturePattern('parity-pattern-second');
  await post(context, '/promote-events', { cwd: context.projectPath, drain: true });
  const patternRows = (await memories(context)).filter(memory => memory.content === patternContent);
  assert.equal(patternRows.length, 1, 'surface-parity:promotion:pattern-threshold');
  assert.ok(patternRows[0].tags.includes('signal:reinforced'));
  const patternEvents = [
    ...await localEvents(context, 'parity-pattern-first'),
    ...await localEvents(context, 'parity-pattern-second'),
  ];
  assert.equal(patternEvents.length, 3);

  await post(context, '/review-stale', {}, 400);
  const stale = await post(context, '/review-stale', { cwd: context.projectPath });
  assert.equal(stale.total, stale.stale.length);
  const beforeDeniedArchive = await context.readProject(context.projectId, storage => storage.promotedMemory.getById(target.id));
  const deniedReview = await context.request('POST', '/review-stale', {
    cwd: context.projectPath, action: 'archive', target_id: target.id,
  }, { auth: false });
  assert.equal(deniedReview.status, 401, 'surface-parity:review-stale:authentication');
  assert.deepEqual(deniedReview.body, { error: 'unauthorized' }, 'surface-parity:review-stale:authentication-result');
  assert.deepEqual(await context.readProject(context.projectId, storage => storage.promotedMemory.getById(target.id)), beforeDeniedArchive, 'surface-parity:review-stale:authentication-no-writes');
  const archived = await post(context, '/review-stale', { cwd: context.projectPath, action: 'archive', target_id: target.id });
  assert.deepEqual(archived, { action: 'archived', id: target.id });
  assert.ok((await context.readProject(context.projectId, storage => storage.promotedMemory.getById(target.id))).archivedAt);
  const revived = await post(context, '/review-stale', { cwd: context.projectPath, action: 'revive', target_id: target.id });
  assert.deepEqual(revived, { action: 'revived', id: target.id });
  assert.equal((await context.readProject(context.projectId, storage => storage.promotedMemory.getById(target.id))).archivedAt, null);
  return [
    record(context, 'cli:promote', { exit: promoted.code, dryRunNoWrites: true, ordinaryProvenance: 'local-project-hash', memoryCreated: true }),
    record(context, 'daemon:POST /promote', { admissionStatus: deniedPromote.status, invalidStatus: 400, repeatPromoted: repeated.promoted, singlePassiveEventReinforcesSameMemory: true, provenanceRetained: true, immediateTiers: [1, 2], patternOccurrences: 3, patternSessions: 2 }),
    record(context, 'daemon:POST /review-stale', { admissionStatus: deniedReview.status, invalidStatus: 400, staleCountConsistent: true, archived: archived.action, revived: revived.action }),
  ];
}

export function expectedHookObservations(backend) {
  assert.ok(['sqlite', 'postgresql'].includes(backend));
  return {
    'cli:restore': { exit: 0, instructionReturned: true, instructionPersisted: true, outbox: 'sqlite-local' },
    'cli:session-end': { exit: 0, persisted: 2, completionRecorded: true, outbox: 'sqlite-local' },
    'cli:session-snapshot': { exit: 0, persisted: 2, duplicateFree: true, outbox: 'sqlite-local' },
    'cli:post-tool': { exit: 0, events: 1, priority: 3, outbox: 'sqlite-local' },
    'cli:user-prompt': { exit: 0, recalledContext: true, decisionCaptured: true, surfacingRecorded: true, outbox: 'sqlite-local' },
    'cli:promote': { exit: 0, dryRunNoWrites: true, ordinaryProvenance: 'local-project-hash', memoryCreated: true },
    'daemon:POST /promote': { admissionStatus: 401, invalidStatus: 400, repeatPromoted: 0, singlePassiveEventReinforcesSameMemory: true, provenanceRetained: true, immediateTiers: [1, 2], patternOccurrences: 3, patternSessions: 2 },
    'daemon:POST /review-stale': { admissionStatus: 401, invalidStatus: 400, staleCountConsistent: true, archived: 'archived', revived: 'revived' },
  };
}

export async function runHookScenario(scenario, context) {
  const ownedIds = scenario === 'hooks' ? HOOKS.map(command => `cli:${command}`)
    : scenario === 'promotion' ? ['cli:promote', 'daemon:POST /promote', 'daemon:POST /review-stale'] : [];
  assert.deepEqual(context.matrix.map(row => row.id).sort(), ownedIds.sort(), 'surface-parity:hook-scenario-denominator');
  for (const row of context.matrix) {
    assert.deepEqual(row.assertions, executedAssertions(row.id), `surface-parity:unexecuted-assertion:${row.id}`);
  }
  if (scenario === 'hooks') return runHooks(context);
  if (scenario === 'promotion') return runPromotion(context);
  throw new Error('surface-parity:unknown-hook-scenario');
}
