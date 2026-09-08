import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createGitFixture, createLinkedWorktreeFixture } from "../../surface-parity/git-fixture.mjs";

const ASSERTIONS = ["arguments", "result", "effects"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ABSENT_ID = "01900000-0000-7000-8000-000000000099";
const REMOTE_REFUSAL = /require.*storage\.backend.*postgresql/iu;
const PATTERN = "parity_private_[0-9]{4}";

function json(result, code = 0) {
  if (result.code !== code) {
    // Emit only a fixed refusal category and this fixture's caller line. CLI
    // payloads can contain private paths or connection details and stay local.
    let error = "";
    try { error = String(JSON.parse(result.stdout).error ?? ""); } catch {}
    const classification = /already a project with stored data/iu.test(error) ? "stored-data"
      : /already mapped|multiple hashes/iu.test(error) ? "path-ownership"
      : /unknown project|not found|does not exist/iu.test(error) ? "missing-project"
      : /binding|reconcil/iu.test(error) ? "binding"
      : "unexpected-status";
    const frames = [...new Error().stack.matchAll(/surface-parity-identity\.mjs:(\d+):\d+/gu)];
    const caller = frames[1]?.[1] ?? "unknown";
    assert.fail(`surface-identity:cli-L${caller}:${classification}`);
  }
  return JSON.parse(result.stdout);
}

function hash(path) {
  return createHash("sha256").update(path).digest("hex");
}

function privateRoot(context, label) {
  const path = join(dirname(context.projectPath), `surface-${label}`);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  // Public project resolution walks parent Git metadata. Give every fixture
  // root its own anchor before any CLI, ingest or pattern operation so a
  // runner's ancestor checkout cannot change its canonical path or hash.
  createGitFixture(path);
  return path;
}

// Snapshot only owned durable bytes. Directory mtimes and open WAL bookkeeping
// are not logical evidence, and unrelated daemon files are outside this scope.
function files(path) {
  if (!existsSync(path)) return {};
  const result = {};
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      for (const [name, bytes] of Object.entries(files(child))) result[`${entry.name}/${name}`] = bytes;
    } else if (entry.isFile()) result[entry.name] = createHash("sha256").update(readFileSync(child)).digest("hex");
    else assert.fail("identity fixture contains an unexpected filesystem leaf");
  }
  return result;
}

function noProjectSqlite(context, paths) {
  if (context.backend !== "postgresql") return;
  for (const path of paths) {
    const projectFiles = Object.keys(files(join(context.homeDir, ".lcm", "projects", hash(path))));
    assert.equal(projectFiles.some((name) => /(?:^|\/)db\.sqlite(?:-|$)/u.test(name)), false,
      "configured PostgreSQL must not create project SQLite");
  }
}

async function invalid(context, command, options = {}) {
  const result = await context.cli([...command, "--surface-parity-invalid-option"], options);
  assert.equal(result.code, 1, "unknown options must fail");
  assert.match(result.stderr, /unknown option/iu);
}

function receipt(id, observation) {
  return { id: `cli:${id}`, assertions: [...ASSERTIONS], verdict: "passed", observation };
}

async function ingest(context, cwd, session, content) {
  const result = await context.request("POST", "/ingest", {
    cwd, session_id: session,
    messages: [{ role: "user", content, tokenCount: 8 }],
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.ingested, 1);
}

async function matches(context, cwd, query) {
  const result = await context.request("POST", "/grep", { cwd, query, mode: "regex", scope: "messages" });
  assert.equal(result.status, 200);
  return result.body.messages ?? result.body.matches;
}

async function identity(context) {
  const rows = [];
  const pg = context.backend === "postgresql";
  const machineFile = join(context.homeDir, ".lcm", "machine.json");
  const priorMachine = existsSync(machineFile) ? readFileSync(machineFile, "utf8") : null;
  await invalid(context, ["machine", "register"]);
  const registeredResult = await context.cli(["machine", "register", "--name", "Surface parity machine", "--json"]);
  if (pg) {
    const registered = json(registeredResult);
    assert.equal(registered.registered, true);
    assert.match(registered.machineId, UUID);
    assert.equal(registered.displayName, "Surface parity machine");
    assert.equal(JSON.parse(readFileSync(machineFile, "utf8")).machineId, registered.machineId);
    const again = json(await context.cli(["machine", "register", "--name", "Surface parity machine", "--json"]));
    assert.equal(again.created, false);
    assert.equal(again.machineId, registered.machineId);
    rows.push(receipt("machine register", { code: registeredResult.code, registered: registered.registered, idempotent: !again.created }));
    await invalid(context, ["machine", "show"]);
    const shown = json(await context.cli(["machine", "show", "--json"]));
    assert.equal(shown.machineId, registered.machineId);
    assert.equal(shown.displayName, registered.displayName);
    rows.push(receipt("machine show", { code: 0, status: shown.status, version: shown.version }));
    const missing = json(await context.cli(["machine", "recover", "--json"]), 1);
    assert.match(missing.error, /missing required argument 'machine-id'/u);
    const recovered = json(await context.cli(["machine", "recover", registered.machineId, "--json"]));
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.machineId, registered.machineId);
    assert.equal(recovered.backupPath, undefined);
    assert.equal(json(await context.cli(["machine", "show", "--json"])).machineId, registered.machineId);
    rows.push(receipt("machine recover", { code: 0, recovered: recovered.recovered, sameIdentity: recovered.machineId === registered.machineId }));
  } else {
    assert.match(json(registeredResult, 1).error, REMOTE_REFUSAL);
    rows.push(receipt("machine register", { code: registeredResult.code, refusal: "postgresql-required" }));
    await invalid(context, ["machine", "show"]);
    const shown = await context.cli(["machine", "show", "--json"]);
    assert.match(json(shown, 1).error, /machine identity is not registered/u);
    rows.push(receipt("machine show", { code: shown.code, refusal: "unregistered" }));
    const recover = await context.cli(["machine", "recover", ABSENT_ID, "--json"]);
    assert.match(json(recover, 1).error, REMOTE_REFUSAL);
    rows.push(receipt("machine recover", { code: recover.code, refusal: "postgresql-required" }));
    assert.equal(existsSync(machineFile) ? readFileSync(machineFile, "utf8") : null, priorMachine);
  }

  const root = privateRoot(context, "identity");
  const other = privateRoot(context, "identity-other");
  const alias = privateRoot(context, "identity-alias");
  await invalid(context, ["project", "create", root]);
  const creation = await context.cli(["project", "create", root, "--name", "Surface parity identity", "--json"]);
  if (pg) {
    const created = json(creation);
    assert.match(created.remote.projectId, UUID);
    assert.equal(created.local.id, hash(root));
    assert.notEqual(created.remote.projectId, created.local.id);
    assert.equal(created.local.remoteProjectId, created.remote.projectId);
    assert.equal(created.remote.displayName, "Surface parity identity");
    assert.equal(json(await context.cli(["project", "show", root, "--json"])).remote.projectId, created.remote.projectId);
    json(await context.cli(["project", "create", other, "--name", "Surface parity unrelated", "--json"]));
    rows.push(receipt("project create", { code: creation.code, created: true, separateRemoteIdentity: created.local.id !== created.remote.projectId }));
  } else {
    assert.match(json(creation, 1).error, REMOTE_REFUSAL);
    rows.push(receipt("project create", { code: creation.code, refusal: "postgresql-required" }));
  }
  await ingest(context, root, "surface-identity-main", "Identity corpus amber nautical separator");
  await ingest(context, other, "surface-identity-other", "Identity corpus cobalt unrelated separator");
  await invalid(context, ["project", "show", root]);
  const shown = json(await context.cli(["project", "show", root, "--json"]));
  assert.equal(shown.hash, hash(root));
  assert.equal(shown.entry.canonical, root);
  assert.equal(Boolean(shown.remote), pg);
  rows.push(receipt("project show", { code: 0, localIdentity: shown.hash === hash(root), remote: Boolean(shown.remote) }));
  await invalid(context, ["project", "link", shown.hash, alias]);
  const linked = json(await context.cli(["project", "link", shown.hash, alias, "--json"]));
  assert.equal(linked.local.id, shown.hash);
  const aliasShown = json(await context.cli(["project", "show", alias, "--json"]));
  assert.equal(aliasShown.hash, shown.hash);
  assert.ok(aliasShown.entry.aliases.includes(alias));
  assert.equal((await matches(context, alias, "amber nautical")).length, 1);
  assert.equal((await matches(context, other, "amber nautical")).length, 0);
  rows.push(receipt("project link", { code: 0, sameProject: aliasShown.hash === shown.hash, isolated: true, remote: Boolean(linked.local.remoteProjectId) }));
  await invalid(context, ["project", "list"]);
  const listed = json(await context.cli(["project", "list", "--json"]));
  assert.equal(listed.local.filter((entry) => entry.hash === shown.hash).length, 1);
  assert.ok(listed.local.find((entry) => entry.hash === shown.hash).aliases.includes(alias));
  assert.ok(listed.local.some((entry) => entry.hash === hash(other)));
  if (pg) assert.ok(listed.remote.some((entry) => entry.projectId === shown.remote.projectId));
  else assert.equal(listed.remote, undefined);
  rows.push(receipt("project list", { code: 0, projectsPresent: 2, remote: Array.isArray(listed.remote) }));
  // Synthetic on-disk Git metadata exercises the production filesystem
  // resolver without requiring a Git executable in the pinned CI image.
  const linkedWorktree = join(dirname(root), "surface-identity-linked-worktree");
  createLinkedWorktreeFixture(root, linkedWorktree);
  // Reconciliation consumes registered aliases and historical Codex metadata;
  // a new Git worktree alone does not declare an LCM project alias.
  const linkedBinding = json(await context.cli(["project", "link", shown.hash, linkedWorktree, "--json"]));
  assert.equal(linkedBinding.local.id, shown.hash);
  await invalid(context, ["project", "reconcile-worktrees", root]);
  const mapPath = join(context.homeDir, ".lcm", "map.json");
  const beforeMap = readFileSync(mapPath, "utf8");
  const reconciled = json(await context.cli(["project", "reconcile-worktrees", linkedWorktree, "--dry-run", "--json"]));
  assert.equal(reconciled.status, "not-needed");
  assert.equal(reconciled.targetHash, shown.hash);
  assert.deepEqual(reconciled.sourceHashes, []);
  assert.deepEqual(reconciled.backupPaths, []);
  assert.ok(reconciled.aliases.includes(linkedWorktree));
  assert.equal(readFileSync(mapPath, "utf8"), beforeMap);
  const applied = json(await context.cli(["project", "reconcile-worktrees", linkedWorktree, "--json"]));
  assert.equal(applied.status, "not-needed");
  assert.equal(applied.targetHash, shown.hash);
  const linkedShown = json(await context.cli(["project", "show", linkedWorktree, "--json"]));
  assert.equal(linkedShown.hash, shown.hash);
  assert.equal((await matches(context, linkedWorktree, "amber nautical")).length, 1);
  rows.push(receipt("project reconcile-worktrees", { code: 0, status: reconciled.status, unchanged: true, linkedWorktree: linkedShown.hash === shown.hash }));
  await invalid(context, ["project", "unlink", alias]);
  const unlinked = json(await context.cli(["project", "unlink", alias, "--json"]));
  assert.equal(unlinked.hash, shown.hash);
  assert.equal(unlinked.aliasRemoved, true);
  assert.equal(json(await context.cli(["project", "show", root, "--json"])).entry.aliases.includes(alias), false);
  assert.equal((await matches(context, root, "amber nautical")).length, 1);
  if (pg) {
    const unbound = await context.request("POST", "/ingest", {
      cwd: alias, session_id: "surface-unbound", messages: [{ role: "user", content: "Must refuse unbound identity", tokenCount: 5 }],
    });
    assert.ok(unbound.status >= 400, "unbound PostgreSQL path must refuse durable writes");
    assert.match(JSON.stringify(unbound.body), /binding|project|postgresql/iu);
    const beforeRejectedLink = readFileSync(mapPath, "utf8");
    const rejected = json(await context.cli(["project", "link", ABSENT_ID, alias, "--json"]), 1);
    assert.match(rejected.error, /not found|does not exist|unknown/iu);
    assert.equal(readFileSync(mapPath, "utf8"), beforeRejectedLink);
    assert.equal(json(await context.cli(["project", "show", alias, "--json"])).entry.remoteProjectId, undefined);
    assert.equal(json(await context.cli(["project", "show", root, "--json"])).remote.projectId, shown.remote.projectId);
    assert.equal((await matches(context, other, "amber nautical")).length, 0);
  }
  noProjectSqlite(context, [root, other, alias, linkedWorktree]);
  rows.push(receipt("project unlink", { code: 0, aliasRemoved: unlinked.aliasRemoved, originalPreserved: true, unboundRefused: pg }));
  if (pg) {
    // The refused ingest establishes an independent unbound identity and its
    // local event coordination file. Alias adoption correctly refuses that
    // stored state. Bind this owned negative fixture as a new project through
    // the public API so later all-project sweeps see only bound identities.
    // The completed unlink assertion above still proves the original boundary.
    const rebound = json(await context.cli(["project", "create", alias, "--json"]));
    assert.equal(rebound.local.id, hash(alias));
    assert.equal(rebound.local.remoteProjectId, rebound.remote.projectId);
    assert.notEqual(rebound.remote.projectId, shown.remote.projectId);
    const reboundAlias = json(await context.cli(["project", "show", alias, "--json"]));
    assert.equal(reboundAlias.hash, hash(alias));
    assert.equal(reboundAlias.remote.projectId, rebound.remote.projectId);
    const original = json(await context.cli(["project", "show", root, "--json"]));
    assert.equal(original.entry.aliases.includes(alias), false);
    assert.equal(original.remote.projectId, shown.remote.projectId);
    assert.equal((await matches(context, root, "amber nautical")).length, 1);
    assert.equal((await matches(context, alias, "amber nautical")).length, 0);
    noProjectSqlite(context, [root, other, alias, linkedWorktree]);
  }
  return rows;
}

async function admin(context) {
  // Identity scenarios use separate roots. Establish this scenario's actual
  // primary-project data through the public route before read-only snapshots.
  await ingest(context, context.projectPath, "surface-admin-baseline", "Migration preserves the primary project corpus");
  const before = await context.readProject(context.projectId,
    async (project) => (await project.conversations.listConversations()).map((row) => row.sessionId).sort());
  await invalid(context, ["postgres", "migrate"]);
  const result = await context.cli(["postgres", "migrate", "--json"], { administrator: true });
  let observation;
  if (context.backend === "postgresql") {
    const migrated = json(result);
    const { loadPostgreSqlMigrations } = await import("../../../dist/src/storage/postgresql/migrations.js");
    assert.equal(migrated.backend, "postgresql");
    assert.deepEqual(migrated.current, loadPostgreSqlMigrations().map((migration) => migration.id));
    assert.deepEqual(migrated.applied, []);
    const again = json(await context.cli(["postgres", "migrate", "--json"], { administrator: true }));
    assert.deepEqual(again, migrated);
    observation = { code: result.code, backend: migrated.backend, applied: migrated.applied, current: migrated.current };
  } else {
    assert.match(json(result, 1).error, /migration requires storage\.backend "postgresql"/u);
    observation = { code: result.code, refusal: "postgresql-required" };
  }
  const after = await context.readProject(context.projectId,
    async (project) => (await project.conversations.listConversations()).map((row) => row.sessionId).sort());
  assert.deepEqual(after, before);
  return [receipt("postgres migrate", observation)];
}

async function events(context) {
  const rows = [];
  const root = privateRoot(context, "events-operator");
  const pg = context.backend === "postgresql";
  if (pg) json(await context.cli(["project", "create", root, "--name", "Surface event operator", "--json"]));
  await ingest(context, root, "surface-events-bootstrap", "Operator baseline corpus");
  const cli = (args) => context.cli(args, { cwd: root });
  for (const path of ["/promote-events", "/promote-events/all", "/promote-events/notify"]) {
    const denied = await context.request("POST", path, { cwd: root }, { auth: false });
    assert.equal(denied.status, 401);
    assert.deepEqual(denied.body, { error: "unauthorized" });
  }
  const malformed = await context.request("POST", "/promote-events", {});
  assert.equal(malformed.status, 400);
  assert.deepEqual(malformed.body, { error: "cwd is required" });
  const direct = await context.request("POST", "/promote-events", { cwd: root, drain: true });
  assert.equal(direct.status, 200);
  assert.equal(direct.body.promoted, 0);
  assert.equal(direct.body.errors, 0);
  assert.equal((await matches(context, root, "Operator baseline corpus")).length, 1);
  rows.push({ id: "daemon:POST /promote-events", assertions: ["admission", "result", "effects"], verdict: "passed",
    observation: { status: direct.status, promoted: direct.body.promoted, errors: direct.body.errors, existingMessagePreserved: true } });
  const all = await context.request("POST", "/promote-events/all", {});
  assert.equal(all.status, 200);
  assert.equal(all.body.promoted, 0);
  assert.equal(all.body.errors, 0);
  assert.equal(all.body.failedProjects, 0);
  assert.equal((await matches(context, root, "Operator baseline corpus")).length, 1);
  rows.push({ id: "daemon:POST /promote-events/all", assertions: ["admission", "result", "effects"], verdict: "passed",
    observation: { status: all.status, promoted: all.body.promoted, errors: all.body.errors, failedProjects: all.body.failedProjects, existingMessagePreserved: true } });
  const badNotification = await context.request("POST", "/promote-events/notify", {});
  assert.equal(badNotification.status, 400);
  assert.deepEqual(badNotification.body, { error: "cwd is required" });
  // Queue a separate empty project; its background drain cannot race the
  // quarantined recovery event below.
  const notifyRoot = privateRoot(context, "events-notify");
  if (pg) json(await context.cli(["project", "create", notifyRoot, "--json"]));
  await ingest(context, notifyRoot, "surface-events-notify", "Notification baseline corpus");
  const notified = await context.request("POST", "/promote-events/notify", { cwd: notifyRoot, priority: 1, pendingCount: 0, sourceHook: "surface-parity" });
  assert.equal(notified.status, 200);
  assert.deepEqual(notified.body, { queued: true });
  const notificationDrain = await context.request("POST", "/promote-events", { cwd: notifyRoot, drain: true });
  assert.equal(notificationDrain.status, 200);
  assert.equal(notificationDrain.body.promoted, 0);
  assert.equal(notificationDrain.body.errors, 0);
  assert.equal((await matches(context, notifyRoot, "Notification baseline corpus")).length, 1);
  rows.push({ id: "daemon:POST /promote-events/notify", assertions: ["admission", "result", "effects"], verdict: "passed",
    observation: { status: notified.status, queued: notified.body.queued, promoted: notificationDrain.body.promoted, existingMessagePreserved: true } });
  await invalid(context, ["events", "promote"], { cwd: root });
  const promoted = json(await cli(["events", "promote", "--json"]));
  assert.equal(promoted.promoted, 0);
  assert.equal(promoted.errors, 0);
  rows.push(receipt("events promote", { code: 0, promoted: promoted.promoted, errors: promoted.errors }));
  for (const command of ["status", "validate", "quarantine"]) {
    await invalid(context, ["events", command], { cwd: root });
    const args = ["events", command, "--json", ...(command === "status" ? [] : ["--limit", "1"])];
    const result = await cli(args);
    if (!pg) {
      assert.match(json(result, 1).error, REMOTE_REFUSAL);
      rows.push(receipt(`events ${command}`, { code: result.code, refusal: "postgresql-required" }));
    } else {
      const value = json(result);
      if (command === "status") {
        for (const key of ["pending", "claimed", "retry", "replicated", "acknowledged", "awaitingRemotePrune", "quarantined"]) assert.equal(value.local[key], 0);
        for (const key of ["pending", "claimed", "retry", "applied", "quarantined"]) assert.equal(value.remote.queue[key], "0");
        rows.push(receipt("events status", { code: result.code, pending: value.local.pending, quarantined: value.local.quarantined, remotePending: value.remote.queue.pending }));
      } else if (command === "validate") {
        assert.deepEqual(value, { checked: 0, matched: 0, missing: [], mismatched: [] });
        rows.push(receipt("events validate", { code: result.code, ...value }));
      } else assert.deepEqual(value, { local: [], remote: [] });
    }
  }
  if (pg) {
    // An operator recovery fixture, never a substitute for the public hooks
    // exercised by the promotion scenario. The permitted local hook outbox is
    // independent from selected project storage.
    const { SQLiteLocalHookOutboxFactory } = await import("../../../dist/src/storage/local-hook-outbox.js");
    const { eventsDbPath } = await import("../../../dist/src/db/events-path.js");
    const factory = new SQLiteLocalHookOutboxFactory();
    const recoverySidecar = eventsDbPath(root);
    try {
      const local = await factory.open(recoverySidecar);
      await local.insertEvent("surface-operator-quarantine", { type: "decision", category: "test", data: "Operator quarantine corpus", priority: 1 }, "surface-parity-recovery-fixture");
      const machine = json(await cli(["machine", "show", "--json"]));
      const [claimed] = await local.claimDeliveries({ machineId: machine.machineId, claimOwner: "surface-operator", limit: 1, staleClaimMs: 60_000 });
      assert.ok(claimed);
      assert.equal(await local.markDeliveryQuarantined(claimed.event_uuid, "surface-operator", "surface operator fixture"), true);
      const quarantined = json(await cli(["events", "quarantine", "--limit", "1", "--json"]));
      assert.equal(quarantined.local.length, 1);
      assert.equal(quarantined.local[0].event_uuid, claimed.event_uuid);
      assert.equal(quarantined.local[0].quarantine_reason, "surface operator fixture");
      assert.deepEqual(quarantined.remote, []);
      rows.push(receipt("events quarantine", { code: 0, local: quarantined.local.length, remote: quarantined.remote.length, reason: quarantined.local[0].quarantine_reason }));
      await invalid(context, ["events", "replay", claimed.event_uuid], { cwd: root });
      const replayed = json(await cli(["events", "replay", claimed.event_uuid, "--machine", machine.machineId, "--json"]));
      assert.deepEqual(replayed, { replayed: true, localReplayed: true, event: null });
      assert.deepEqual(await local.listQuarantined(), []);
      assert.equal((await local.getDeliveryDiagnostics()).pending, 1);
      const repeat = json(await cli(["events", "replay", claimed.event_uuid, "--json"]), 1);
      assert.equal(repeat.replayed, false);
      rows.push(receipt("events replay", { code: 0, ...replayed, repeatCode: 1 }));
      await local.markProcessed([claimed.event_id]);
      assert.equal((await local.getUnprocessed()).length, 0);
    } finally {
      await factory.close();
      // This exact sidecar belongs only to the injected recovery fixture.
      // Remove it after public readback so later all-project sweeps cannot
      // process a synthetic operator event as ordinary hook evidence.
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${recoverySidecar}${suffix}`, { force: true });
    }
  } else {
    await invalid(context, ["events", "replay", ABSENT_ID], { cwd: root });
    const replay = await cli(["events", "replay", ABSENT_ID, "--json"]);
    assert.match(json(replay, 1).error, REMOTE_REFUSAL);
    rows.push(receipt("events replay", { code: replay.code, refusal: "postgresql-required" }));
  }
  noProjectSqlite(context, [root, notifyRoot]);
  return rows;
}

async function sensitive(context) {
  const root = privateRoot(context, "sensitive");
  const cli = (args) => context.cli(["sensitive", ...args], { cwd: root });
  const path = join(context.homeDir, ".lcm", "projects", hash(root));
  const configPath = join(context.homeDir, ".lcm", "config.json");
  const configBefore = readFileSync(configPath, "utf8");
  const dispatcher = await cli([]);
  assert.equal(dispatcher.code, 1);
  assert.match(dispatcher.stdout, /^Usage: lcm sensitive <list\|add\|remove\|test\|purge>/u);
  assert.deepEqual(files(path), {});
  const rows = [receipt("sensitive", { code: dispatcher.code, usage: true })];
  // Adding stores pattern text; regex validation belongs to later use. The
  // documented argument failure is an omitted pattern, which must not write.
  let missingPatternChecked = false;
  try {
    const missingPattern = await cli(["add"]);
    assert.equal(missingPattern.code, 1);
    assert.equal(missingPattern.stdout, 'Usage: lcm sensitive add [--global] "<pattern>"\n');
    assert.deepEqual(files(path), {});
    missingPatternChecked = true;
  } finally {
    // If argument handling regresses, prevent its accidental fixture pattern
    // from poisoning a later scenario while preserving the failed assertion.
    if (!missingPatternChecked) rmSync(join(path, "sensitive-patterns.txt"), { force: true });
  }
  const added = await cli(["add", PATTERN]);
  assert.equal(added.code, 0);
  assert.match(added.stdout, /Added project pattern:/u);
  assert.equal(readFileSync(join(path, "sensitive-patterns.txt"), "utf8"), `${PATTERN}\n`);
  assert.equal((await cli(["add", PATTERN])).code, 0);
  assert.equal(readFileSync(join(path, "sensitive-patterns.txt"), "utf8"), `${PATTERN}\n`);
  rows.push(receipt("sensitive add", { code: added.code, patterns: 1, duplicateIgnored: true }));
  const patternBytes = files(path);
  const listed = await cli(["list"]);
  assert.equal(listed.code, 0);
  assert.ok(listed.stdout.includes(`[user]      ${PATTERN}`));
  assert.match(listed.stdout, /Built-in patterns:/u);
  assert.deepEqual(files(path), patternBytes);
  rows.push(receipt("sensitive list", { code: listed.code, projectPattern: true, unchanged: true }));
  assert.equal((await cli(["test"])).code, 1);
  const tested = await cli(["test", "before parity_private_1234 after"]);
  assert.equal(tested.code, 0);
  assert.ok(tested.stdout.includes(`[project]  ${PATTERN}`));
  const redacted = tested.stdout.split("\n").find((line) => line.startsWith("Redacted: "));
  assert.ok(redacted);
  assert.equal(redacted.includes("parity_private_1234"), false);
  assert.ok(redacted.includes("before ") && redacted.endsWith(" after"));
  assert.deepEqual(files(path), patternBytes);
  rows.push(receipt("sensitive test", { code: tested.code, matched: true, redacted: true, contextPreserved: true }));
  assert.equal((await cli(["remove"])).code, 1);
  const removed = await cli(["remove", PATTERN]);
  assert.equal(removed.code, 0);
  assert.match(removed.stdout, /Removed project pattern:/u);
  assert.equal(readFileSync(join(path, "sensitive-patterns.txt"), "utf8").includes(PATTERN), false);
  assert.equal((await cli(["remove", PATTERN])).code, 1);
  rows.push(receipt("sensitive remove", { code: removed.code, patterns: 0, missingCode: 1 }));
  const beforePurge = files(path);
  const confirmation = await cli(["purge"]);
  assert.equal(confirmation.code, 1);
  assert.match(confirmation.stdout, /requires --yes/u);
  assert.deepEqual(files(path), beforePurge);
  const purged = await cli(["purge", "--yes"]);
  if (context.backend === "postgresql") {
    assert.equal(purged.code, 1);
    assert.match(`${purged.stdout}\n${purged.stderr}`, /not available.*postgresql/iu);
    assert.deepEqual(files(path), beforePurge);
    rows.push(receipt("sensitive purge", { code: purged.code, refusal: "postgresql-unavailable", unchanged: true }));
  } else {
    assert.equal(purged.code, 0);
    assert.match(purged.stdout, /Purged project data:/u);
    assert.equal(existsSync(path), false);
    rows.push(receipt("sensitive purge", { code: purged.code, removed: true }));
  }
  assert.equal(readFileSync(configPath, "utf8"), configBefore);
  noProjectSqlite(context, [root]);
  return rows;
}

export async function runIdentityScenario(scenario, context) {
  const run = { identity, admin, events, sensitive }[scenario];
  assert.ok(run, `unknown identity workflow ${scenario}`);
  const rows = await run(context);
  const expected = context.matrix.filter((row) => row.scenario === scenario).map((row) => row.id).sort();
  assert.deepEqual(rows.map((row) => row.id).sort(), expected, "identity workflow owns its exact denominator");
  for (const row of rows) {
    assert.deepEqual(row.assertions, context.matrix.find((entry) => entry.id === row.id).assertions,
      "identity receipts must prove the declared assertion set without copying it");
  }
  return rows;
}

// Declared independently from runtime results. Architecture-specific rows must
// meet these expectations before cross-backend comparison can certify them.
export function expectedIdentityObservations(backend) {
  assert.ok(backend === "sqlite" || backend === "postgresql");
  const pg = backend === "postgresql";
  const refusal = { code: 1, refusal: "postgresql-required" };
  return {
    "cli:machine register": pg ? { code: 0, registered: true, idempotent: true } : refusal,
    "cli:machine show": pg ? { code: 0, status: "registered", version: 1 } : { code: 1, refusal: "unregistered" },
    "cli:machine recover": pg ? { code: 0, recovered: true, sameIdentity: true } : refusal,
    "cli:project create": pg ? { code: 0, created: true, separateRemoteIdentity: true } : refusal,
    "cli:project show": { code: 0, localIdentity: true, remote: pg },
    "cli:project link": { code: 0, sameProject: true, isolated: true, remote: pg },
    "cli:project list": { code: 0, projectsPresent: 2, remote: pg },
    "cli:project reconcile-worktrees": { code: 0, status: "not-needed", unchanged: true, linkedWorktree: true },
    "cli:project unlink": { code: 0, aliasRemoved: true, originalPreserved: true, unboundRefused: pg },
    "cli:postgres migrate": pg ? { code: 0, backend: "postgresql", applied: [], current: ["0001_migration_ledger", "0002_schema_baseline", "0003_machine_identity_key", "0004_machine_display_name", "0005_summary_context_integrity", "0006_transfer_ledger"] } : refusal,
    "cli:events promote": { code: 0, promoted: 0, errors: 0 },
    "cli:events status": pg ? { code: 0, pending: 0, quarantined: 0, remotePending: "0" } : refusal,
    "cli:events validate": pg ? { code: 0, checked: 0, matched: 0, missing: [], mismatched: [] } : refusal,
    "cli:events quarantine": pg ? { code: 0, local: 1, remote: 0, reason: "surface operator fixture" } : refusal,
    "cli:events replay": pg ? { code: 0, replayed: true, localReplayed: true, event: null, repeatCode: 1 } : refusal,
    "cli:sensitive purge": pg ? { code: 1, refusal: "postgresql-unavailable", unchanged: true } : { code: 0, removed: true },
  };
}
