import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StorageIdentityContext } from '../storage/contracts.js';
import type { PostgreSqlConnectionSettings } from '../storage/postgresql/contracts.js';
import { PostgreSqlCommitOutcomeUnknownError } from '../storage/postgresql/errors.js';
import { probePostgreSqlPortableDestination } from '../storage/postgresql/portable-destination.js';
import { canonicalJson, canonicalSha256, PORTABLE_RECORD_DOMAIN_ORDER } from '../storage/portable-record.js';
import { serializePortableCheckpoint, type PortableBatch, type PortableCheckpoint } from '../storage/portable-record-stream.js';
import { withBackendPublicationAppendBarrierAsync } from '../storage/backend-publication.js';
import { openMigrationCopySource, bindMigrationCopySource, type MigrationCopySource } from './copy-source.js';
import { migrationCopyLimits, openMigrationCopyDestination, type MigrationCopyLimitsInput } from './copy-destination.js';
import { MigrationManifestStore } from './manifest-store.js';
import { beginMigrationEffect, completeMigrationEffect, type MigrationManifest, type MigrationEffectKind, type MigrationCheckpoint } from './protocol.js';
export interface SqliteMigrationCopyInput extends MigrationCopyLimitsInput {
    readonly generationId: string;
    readonly homeDir: string;
    readonly settings: PostgreSqlConnectionSettings;
    readonly expectedOwner: string;
    readonly expectedIdentity: StorageIdentityContext;
    readonly ownerProcessId: string;
    readonly signal?: AbortSignal;
}
export type MigrationCopyBoundary = 'before-source' | 'after-source' | 'before-begin' | 'after-begin' | 'before-batch' | 'after-batch-readback' | 'before-checkpoint' | 'after-checkpoint' | 'before-completion' | 'after-completion-readback';
export interface MigrationCopyTestingDependencies {
    readonly observe?: (boundary: MigrationCopyBoundary) => Promise<void>;
}
export class MigrationCopyError extends Error {
    constructor() { super('Migration copy could not prove the requested generation; retained evidence is required to resume.'); this.name = 'MigrationCopyError'; }
}
function refuse(): never { throw new MigrationCopyError(); }
function snapshotInput(input: SqliteMigrationCopyInput): SqliteMigrationCopyInput {
    if (Reflect.ownKeys(input).some(key => typeof key !== 'string' || !['generationId', 'homeDir', 'settings', 'expectedOwner', 'expectedIdentity', 'ownerProcessId', 'maxRecords', 'maxBytes', 'leaseTtlMs', 'maximumTransactionAttempts', 'signal', 'destinationCapturedAt'].includes(key)))
        refuse();
    migrationCopyLimits(input);
    if (typeof input.ownerProcessId !== 'string' || !input.ownerProcessId.trim() || typeof input.homeDir !== 'string' || !input.homeDir)
        refuse();
    return { ...input, settings: { ...input.settings }, expectedIdentity: { ...input.expectedIdentity } };
}
function underSource<T>(source: MigrationCopySource, operation: (reauthenticate: () => Promise<void>) => Promise<T>): Promise<T> {
    return withBackendPublicationAppendBarrierAsync(source.homeDir, async (token) => {
        const reauthenticate = () => source.reauthenticateHeld(token);
        await reauthenticate();
        return operation(reauthenticate);
    });
}
function sameSuccessor(actual: MigrationManifest, intended: MigrationManifest): boolean {
    const logical = (value: MigrationManifest) => ({ ...value, checksumSha256: null, updatedAt: null,
        pendingEffect: value.pendingEffect ? { ...value.pendingEffect, startedAt: null } : null });
    return canonicalJson(logical(actual)) === canonicalJson(logical(intended));
}
/** Inspection supplies recipe-v1 witnesses only; it never writes a dry-run journal. */
export async function inspectSqliteMigrationCopy(input: SqliteMigrationCopyInput & {
    destinationCapturedAt: string;
}) {
    const saved = snapshotInput(input);
    const scratch = mkdtempSync(join(tmpdir(), 'lcm-copy-inspection-'));
    let source: MigrationCopySource | undefined;
    let primary: unknown;
    try {
        if (new Date(input.destinationCapturedAt).toISOString() !== input.destinationCapturedAt)
            refuse();
        source = await openMigrationCopySource({ generationId: saved.generationId, homeDir: saved.homeDir, expectedIdentity: saved.expectedIdentity, signal: saved.signal, scratchParent: scratch });
        const probe = await probePostgreSqlPortableDestination(saved);
        const bound = bindMigrationCopySource(source, { ...saved, destinationCapturedAt: input.destinationCapturedAt, targetProbe: probe });
        if (!probe.existingRun && !probe.nonIdentityDomainsEmpty)
            refuse();
        await source.reauthenticate();
        return { source: source.sourceWitness, destination: bound.destinationWitness, bindingSha256: bound.bindingSha256 };
    }
    catch (error) {
        primary = error;
        if (error instanceof PostgreSqlCommitOutcomeUnknownError)
            throw error;
        throw new MigrationCopyError();
    }
    finally {
        try {
            await source?.stream.close();
        }
        catch {
            if (primary === undefined)
                throw new MigrationCopyError();
        }
        finally {
            rmSync(scratch, { recursive: true, force: true });
        }
    }
}
/** Bounded copy consumes canonical batches and publishes only exact durable proof. */
export async function runSqliteMigrationCopy(rawInput: SqliteMigrationCopyInput, testing: MigrationCopyTestingDependencies = {}) {
    const input = snapshotInput(rawInput);
    const limits = migrationCopyLimits(input);
    const store = new MigrationManifestStore({ homeDir: input.homeDir });
    let current = store.read(input.generationId);
    if (!['dry-run-verified', 'copying', 'copied'].includes(current.phase)
        || current.pendingEffect && !['copy-batch', 'complete-copy'].includes(current.pendingEffect.kind))
        refuse();
    const scratch = mkdtempSync(join(tmpdir(), 'lcm-migration-copy-'));
    let source: MigrationCopySource | undefined;
    let destination: Awaited<ReturnType<typeof openMigrationCopyDestination>> | undefined;
    let primary: unknown;
    const observe = async (boundary: MigrationCopyBoundary) => { if (input.signal?.aborted)
        refuse(); await testing.observe?.(boundary); if (input.signal?.aborted)
        refuse(); };
    try {
        await observe('before-source');
        source = await openMigrationCopySource({ generationId: input.generationId, homeDir: input.homeDir, expectedIdentity: input.expectedIdentity, signal: input.signal, scratchParent: scratch });
        await observe('after-source');
        const probe = await probePostgreSqlPortableDestination(input);
        const bound = bindMigrationCopySource(source, { ...input, destinationCapturedAt: current.destination.capturedAt, targetProbe: probe });
        if (canonicalJson(current.source) !== canonicalJson(source.sourceWitness) || canonicalJson(current.destination) !== canonicalJson(bound.destinationWitness))
            refuse();
        if (probe.existingRun) {
            if (probe.existingRun.runId !== bound.runId || probe.existingRun.targetGenerationId !== bound.targetGenerationId || probe.existingRun.manifestSha256 !== source.stream.describe().manifestSha256)
                refuse();
        }
        else if (!probe.nonIdentityDomainsEmpty || current.phase !== 'dry-run-verified')
            refuse();
        const authenticated = source;
        destination = await openMigrationCopyDestination({ ...input, ...limits, generationId: bound.targetGenerationId, runId: bound.runId,
            source: source.stream, scratchParent: scratch, withSourceAuthority: operation => underSource(authenticated, operation) });
        await destination.admit(current.phase !== 'dry-run-verified');
        const manifest = source.stream.describe();
        const publish = async (next: MigrationManifest) => underSource(authenticated, async () => {
            try {
                current = store.update(input.generationId, current.checksumSha256, () => next);
            }
            catch (error) {
                const observed = store.read(input.generationId);
                if (!sameSuccessor(observed, next))
                    throw error;
                current = observed;
            }
        });
        const begin = async (kind: MigrationEffectKind, inputSha256: string) => {
            const effectId = `migration-copy-${inputSha256}`;
            if (current.pendingEffect) {
                if (current.pendingEffect.kind !== kind || current.pendingEffect.effectId !== effectId || current.pendingEffect.inputSha256 !== inputSha256)
                    refuse();
            }
            else {
                await observe('before-begin');
                await publish(beginMigrationEffect(current, { kind, effectId, inputSha256, startedAt: new Date().toISOString() }));
                await observe('after-begin');
            }
            return effectId;
        };
        const receiptHash = (batch: PortableBatch, batchSha256: string) => migrationCopyBatchCommitSha256({
            bindingSha256: bound.bindingSha256, runId: bound.runId, generationId: input.generationId, targetGenerationId: bound.targetGenerationId,
            targetProjectId: input.expectedIdentity.id, manifestSha256: manifest.manifestSha256, batch, batchSha256
        });
        const terminal: PortableCheckpoint[] = [];
        for (const domain of PORTABLE_RECORD_DOMAIN_ORDER) {
            const local = current.checkpoints.find(checkpoint => checkpoint.domain === domain);
            let after: PortableCheckpoint | undefined;
            let localMatched = local === undefined;
            do {
                await observe('before-batch');
                const batch = await source.stream.readBatch({ domain, after, maxRecords: limits.maxRecords, maxBytes: limits.maxBytes, signal: input.signal });
                await source.stream.verify(batch.checkpoint);
                if (local && batch.checkpoint.nextOrdinal <= local.ordinal) {
                    const receipt = await destination.readBatch(batch);
                    if (!receipt)
                        refuse();
                    if (batch.checkpoint.nextOrdinal === local.ordinal) {
                        if (local.sourceCheckpointSha256 !== batch.checkpoint.checkpointSha256 || local.recordCount !== batch.checkpoint.recordCount
                            || local.destinationCommitSha256 !== receiptHash(batch, receipt.batchSha256))
                            refuse();
                        localMatched = true;
                    }
                }
                else {
                    if (!localMatched || current.phase === 'copied')
                        refuse();
                    const effectHash = canonicalSha256({ version: 1, kind: 'migration-copy-batch', bindingSha256: bound.bindingSha256,
                        runId: bound.runId, domain, priorCheckpointSha256: batch.priorCheckpointSha256, checkpointSha256: batch.checkpoint.checkpointSha256 });
                    const effectId = await begin('copy-batch', effectHash);
                    let receipt = await destination.readBatch(batch);
                    receipt ??= await destination.applyBatch(batch);
                    await observe('after-batch-readback');
                    const checkpoint: MigrationCheckpoint = { domain, ordinal: batch.checkpoint.nextOrdinal, recordCount: batch.checkpoint.recordCount,
                        sourceCheckpointSha256: batch.checkpoint.checkpointSha256, destinationCommitSha256: receiptHash(batch, receipt.batchSha256) };
                    await observe('before-checkpoint');
                    await publish(completeMigrationEffect(current, { effectId, completedAt: new Date().toISOString(), checkpoint }));
                    await observe('after-checkpoint');
                }
                after = batch.checkpoint;
            } while (!after.complete);
            if (!localMatched)
                refuse();
            terminal.push(after);
        }
        if (current.checkpoints.length !== PORTABLE_RECORD_DOMAIN_ORDER.length)
            refuse();
        const verification = await destination.verify();
        if (current.phase === 'copied') {
            if (current.pendingEffect || !await destination.readCompleted(verification))
                refuse();
        }
        else {
            const inputSha256 = canonicalSha256({ version: 1, kind: 'migration-copy-completion', bindingSha256: bound.bindingSha256,
                runId: bound.runId, targetGenerationId: bound.targetGenerationId, manifestSha256: manifest.manifestSha256,
                checkpoints: terminal.map(checkpoint => checkpoint.checkpointSha256), contentSha256: manifest.contentSha256 });
            const effectId = await begin('complete-copy', inputSha256);
            await observe('before-completion');
            if (!await destination.readCompleted(verification))
                await destination.complete(verification);
            await observe('after-completion-readback');
            await publish(completeMigrationEffect(current, { effectId, completedAt: new Date().toISOString() }));
        }
        await source.reauthenticate();
        return { phase: 'copied' as const, generationId: input.generationId, targetGenerationId: bound.targetGenerationId, runId: bound.runId, bindingSha256: bound.bindingSha256,
            artifactSha256: source.snapshot.artifact.artifactSha256, sourceByteWitnessSha256: source.snapshot.artifact.sourceByteWitnessSha256,
            manifestSha256: manifest.manifestSha256, journalSha256: current.checksumSha256, snapshotSha256: source.snapshot.checksumSha256,
            receiptSetSha256: source.snapshot.receiptReference.receiptSetSha256, queueSetSha256: source.snapshot.receiptReference.queueSetSha256,
            maintenanceChecksumSha256: source.snapshot.artifact.maintenanceChecksumSha256, checkpoints: current.checkpoints,
            commitRootSha256: canonicalSha256(current.checkpoints.map(checkpoint => checkpoint.destinationCommitSha256)) };
    }
    catch (error) {
        primary = error;
        if (error instanceof PostgreSqlCommitOutcomeUnknownError)
            throw error;
        throw new MigrationCopyError();
    }
    finally {
        let cleanup: unknown;
        try {
            await destination?.close();
        }
        catch (error) {
            cleanup = error;
        }
        try {
            await source?.stream.close();
        }
        catch (error) {
            cleanup ??= error;
        }
        rmSync(scratch, { recursive: true, force: true });
        if (primary === undefined && cleanup !== undefined)
            throw new MigrationCopyError();
    }
}
/** Recipe-v1 erratum: checkpointBytes is exact canonical UTF-8 text, not a typed array. */
export function migrationCopyBatchCommitSha256(input: {
    bindingSha256: string;
    runId: string;
    generationId: string;
    targetGenerationId: string;
    targetProjectId: string;
    manifestSha256: string;
    batch: PortableBatch;
    batchSha256: string;
}): string {
    const { batch, ...identity } = input;
    return canonicalSha256({ version: 1, kind: 'migration-copy-batch-commit', ...identity, domain: batch.domain,
        priorCheckpointSha256: batch.priorCheckpointSha256, checkpointSha256: batch.checkpoint.checkpointSha256,
        checkpointBytes: Buffer.from(serializePortableCheckpoint(batch.checkpoint)).toString('utf8') });
}
