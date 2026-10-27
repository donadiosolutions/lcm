import { join } from "node:path";
import { normalizeProjectPath } from "../project-map.js";
import type { StorageIdentityContext } from "../storage/contracts.js";
import {
    readBackendMaintenanceJournal, resolveBackendMaintenanceGenerationBinding,
    withBackendPublicationAppendBarrierAsync, type BackendPublicationLockToken,
} from "../storage/backend-publication.js";
import { loadPostgreSqlMigrations } from "../storage/postgresql/migrations.js";
import { IDENTITY_DOMAINS } from "../storage/postgresql/portable-destination.js";
import { PORTABLE_RECORD_DOMAIN_ORDER, canonicalSha256, canonicalJson } from "../storage/portable-record.js";
import { createPortableRecordStream, type PortableRecordStream } from "../storage/portable-record-stream.js";
import { openSqlitePortableSource, type SqlitePortableIdentityFacts, type SqlitePortableRecordSource } from "../storage/sqlite/portable-source.js";
import { authenticateSqliteMigrationSource } from "./maintenance.js";
import { inspectAuthenticatedSqliteMigrationSnapshot, type AuthenticatedSqliteMigrationSnapshot } from "./queue-evidence.js";
import type { MigrationStorageWitness } from "./protocol.js";
export interface MigrationCopySourceInput {
    readonly generationId: string;
    readonly homeDir: string;
    readonly expectedIdentity: StorageIdentityContext;
    readonly scratchParent: string;
    readonly signal?: AbortSignal;
}
function refuse(): never { throw new Error("migration copy source authority does not match"); }
/** The preserved snapshot's portable source, derived from the authenticated snapshot alone (#1550 C1). */
export type PreservedSqliteSource = Readonly<{
    facts: SqlitePortableIdentityFacts;
    extraInstructionAbsenceSha256: string;
    sourceWitness: MigrationStorageWitness;
    /** Opens the raw portable source over the sealed snapshot files; the caller streams and closes it. */
    open(options: Readonly<{ scratchParent: string; signal?: AbortSignal }>): Promise<SqlitePortableRecordSource>;
}>;
/**
 * The narrow raw-source seam (#1550 C1): from an ALREADY authenticated preserved snapshot and the expected project
 * identity it derives exactly the roles, aliases and facts, file hashes and absent-extra-instructions evidence the
 * forward copy source uses, and opens the sealed snapshot's portable source. It performs no live-source or hold
 * check: openMigrationCopySource keeps those around it, and a set rollback (whose members are no longer held
 * forward) authenticates the snapshot against its own frozen evidence instead.
 */
export function derivePreservedSqliteSource(
    snapshot: AuthenticatedSqliteMigrationSnapshot,
    expectedIdentity: StorageIdentityContext,
    homeDir: string,
): PreservedSqliteSource {
    const artifact = snapshot.artifact;
    const authority = artifact.authority;
    const expected = { ...expectedIdentity };
    const paths = [authority.canonicalPath, ...authority.aliases];
    const facts = {
        sourceLocalProjectId: authority.physicalProjectId,
        machines: [authority.machineIdentity],
        aliases: paths.map(path => ({ machineIdentityKey: authority.machineIdentity.identityKey, path, normalizedPath: normalizeProjectPath(path) })),
    };
    if (authority.projectIdentity.scope !== "local" || expected.id !== expected.remoteProjectId
        || expected.localProjectId !== authority.physicalProjectId || expected.machineId !== authority.machineIdentity.machineId
        || expected.canonical !== authority.canonicalPath || !expected.selectedPath || !paths.includes(expected.selectedPath))
        refuse();
    const project = artifact.roles.find(role => role.role === "project")!;
    // #622 queue evidence requires the enrolled canonical events database.
    const events = artifact.roles.find(role => role.role === "passive-events")!;
    const extraInstructionAbsenceSha256 = canonicalSha256({ version: 1,
        kind: "migration-extra-instruction-captures-absent", topology: "current-single-project-database",
        snapshotSha256: snapshot.checksumSha256, projectRoleSha256: project.checksumSha256,
        machineIdentityKey: authority.machineIdentity.identityKey, capturedRoles: artifact.roles.map(role => role.role) });
    const sourceWitness: MigrationStorageWitness = { version: 1, backend: "sqlite", identitySha256: artifact.sourceSelectionSha256,
        schemaSha256: artifact.schemaSha256, contentSha256: artifact.contentSha256, capturedAt: artifact.capturedAt };
    const directory = join(homeDir, ".lcm", "migration-snapshots", "generations", artifact.generationId);
    const open = (options: Readonly<{ scratchParent: string; signal?: AbortSignal }>) => openSqlitePortableSource({
        databasePath: join(directory, project.normalizedMain.relativePath), expectedFileSha256: project.normalizedMain.sha256,
        projectIdentity: { scope: "shared", projectId: expected.id }, sourceLocalProjectId: authority.physicalProjectId,
        identityFacts: facts, expectedFactsSha256: canonicalSha256(facts), machineIdentityKey: authority.machineIdentity.identityKey,
        capturedSidecars: { events: { databasePath: join(directory, events.normalizedMain.relativePath),
                expectedFileSha256: events.normalizedMain.sha256, machineIdentityKey: authority.machineIdentity.identityKey },
            instructions: { absent: true, evidenceSha256: extraInstructionAbsenceSha256 } },
        capturedAt: artifact.capturedAt.replace(/\.(\d{3})Z$/u, ".$1000Z"), scratchParent: options.scratchParent, signal: options.signal,
    });
    return { facts, extraInstructionAbsenceSha256, sourceWitness, open };
}
/** Captures are authenticated by #622; only its validated role paths are opened. */
export async function openMigrationCopySource(input: MigrationCopySourceInput) {
    const allowedKeys = ['generationId', 'homeDir', 'expectedIdentity', 'scratchParent', 'signal'];
    const hasUnexpectedKey = Reflect.ownKeys(input).some(
        key => typeof key !== 'string' || !allowedKeys.includes(key),
    );
    if (hasUnexpectedKey) refuse();
    const snapshot = await inspectAuthenticatedSqliteMigrationSnapshot(input.generationId, input.homeDir);
    const artifact = snapshot.artifact;
    const authority = artifact.authority;
    const preserved = derivePreservedSqliteSource(snapshot, input.expectedIdentity, input.homeDir);
    const { facts, extraInstructionAbsenceSha256, sourceWitness } = preserved;
    const reauthenticateHeld = async (token: BackendPublicationLockToken): Promise<void> => {
        if (input.signal?.aborted)
            throw new Error("migration copy cancelled");
        const current = authenticateSqliteMigrationSource(authority.canonicalPath, input.homeDir, token);
        const maintenance = readBackendMaintenanceJournal(input.homeDir);
        // The hold is compared through this generation's own binding view (#1548): for a single-generation
        // journal the view is the journal itself; for a cutover set it is the member's binding, which a
        // sibling's capture never moves. The phase stays the journal's.
        const view = resolveBackendMaintenanceGenerationBinding(maintenance, input.generationId);
        if (canonicalJson(current) !== canonicalJson(authority) || !maintenance || maintenance.phase !== "maintenance-held"
            || view === null || view.checksumSha256 !== artifact.maintenanceChecksumSha256
            || view.sourceSelectionSha256 !== artifact.sourceSelectionSha256 || view.roster.length !== 1
            || view.roster[0]!.machineId !== authority.machineIdentity.machineId
            || view.roster[0]!.queueCutoff !== snapshot.receiptReference.queueCutoff
            || view.roster[0]!.evidenceSha256 !== artifact.sourceByteWitnessSha256
            || facts.aliases.some(alias => normalizeProjectPath(alias.path) !== alias.normalizedPath))
            refuse();
        const observed: AuthenticatedSqliteMigrationSnapshot = await inspectAuthenticatedSqliteMigrationSnapshot(input.generationId, input.homeDir);
        if (canonicalJson(observed) !== canonicalJson(snapshot))
            refuse();
        // Recheck after asynchronous filesystem/SQLite authentication. The view checksum covers the journal
        // phase, so equality with the checked view also proves the hold is still held for this member.
        if (canonicalJson(authenticateSqliteMigrationSource(authority.canonicalPath, input.homeDir, token)) !== canonicalJson(authority)
            || resolveBackendMaintenanceGenerationBinding(readBackendMaintenanceJournal(input.homeDir), input.generationId)?.checksumSha256 !== view.checksumSha256)
            refuse();
    };
    const reauthenticate = () => withBackendPublicationAppendBarrierAsync(input.homeDir, reauthenticateHeld);
    await reauthenticate();
    const raw = await preserved.open({ scratchParent: input.scratchParent, signal: input.signal });
    let stream: PortableRecordStream | undefined;
    try {
        stream = await createPortableRecordStream(raw);
        await reauthenticate();
        return { homeDir: input.homeDir, stream, snapshot, sourceWitness, facts, extraInstructionAbsenceSha256, reauthenticate, reauthenticateHeld };
    }
    catch (error) {
        try {
            if (stream)
                await stream.close();
            else
                await raw.close();
        }
        catch { /* preserve setup error */ }
        throw error;
    }
}
export function migrationCopyTargetGeneration(generationId: string): string {
    return `migration-generation-${canonicalSha256({ version: 1, kind: 'sqlite-postgresql-copy-generation', generationId })}`;
}
export type MigrationCopySource = Awaited<ReturnType<typeof openMigrationCopySource>>;
export function bindMigrationCopySource(source: MigrationCopySource, input: {
    expectedOwner: string;
    expectedIdentity: StorageIdentityContext;
    destinationCapturedAt: string;
    targetProbe: import('../storage/postgresql/portable-destination.js').PostgreSqlPortableDestinationProbe;
}) {
    const { snapshot, facts, extraInstructionAbsenceSha256, sourceWitness } = source;
    const { artifact } = snapshot;
    const identity = input.expectedIdentity;
    const targetGenerationId = migrationCopyTargetGeneration(artifact.generationId);
    const destination: MigrationStorageWitness = { version: 1, backend: 'postgresql',
        identitySha256: input.targetProbe.destinationWitnessSha256,
        schemaSha256: canonicalSha256(loadPostgreSqlMigrations().map(({ id, sha256 }) => ({ id, sha256 }))),
        contentSha256: canonicalSha256({ version: 1, kind: 'admitted-empty-postgresql-copy-target',
            identityFingerprintSha256: input.targetProbe.identityFingerprintSha256,
            emptyDomains: PORTABLE_RECORD_DOMAIN_ORDER.filter(domain => !(IDENTITY_DOMAINS as readonly string[]).includes(domain)) }),
        capturedAt: input.destinationCapturedAt, systemIdentifier: input.targetProbe.systemIdentifier };
    const view = resolveBackendMaintenanceGenerationBinding(readBackendMaintenanceJournal(source.homeDir), artifact.generationId);
    if (view === null || view.checksumSha256 !== artifact.maintenanceChecksumSha256)
        refuse();
    const binding = { version: 1, kind: 'sqlite-postgresql-migration-copy', generationId: artifact.generationId, targetGenerationId,
        localProjectId: artifact.authority.physicalProjectId, canonicalProjectIdentity: { scope: 'shared', projectId: identity.id },
        machineIdentity: artifact.authority.machineIdentity, identityFactsSha256: canonicalSha256(facts), extraInstructionAbsenceSha256,
        snapshotSha256: snapshot.checksumSha256, artifactSha256: artifact.artifactSha256, artifactChecksumSha256: artifact.checksumSha256,
        sourceByteWitnessSha256: artifact.sourceByteWitnessSha256, maintenanceChecksumSha256: artifact.maintenanceChecksumSha256,
        maintenanceRoster: view.roster, receiptReference: snapshot.receiptReference, portableManifestSha256: source.stream.describe().manifestSha256,
        source: sourceWitness, destination, targetIdentity: { id: identity.id, remoteProjectId: identity.remoteProjectId,
            localProjectId: identity.localProjectId, machineId: identity.machineId, selectedPath: identity.selectedPath, canonical: identity.canonical },
        expectedSchemaOwner: input.expectedOwner };
    const bindingSha256 = canonicalSha256(binding);
    return { binding, bindingSha256, runId: `migration-copy-${bindingSha256}`, targetGenerationId, destinationWitness: destination };
}
