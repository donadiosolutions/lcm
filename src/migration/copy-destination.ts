import { PostgreSqlCommitOutcomeUnknownError, PostgreSqlStorageOperationError } from '../storage/postgresql/errors.js';
import { PostgreSqlRuntime } from '../storage/postgresql/runtime.js';
import { PostgreSqlWorkCoordinator, type PostgreSqlFencedLease } from '../storage/postgresql/coordination.js';
import {
    createPostgreSqlPortableDestination,
    admitPortableDestinationInTransaction,
    readPortableRunInTransaction,
    readPortableBatchReceiptInTransaction,
    applyPortableBatchInTransaction,
    verifyPortableDestinationComplete,
    completePortableDestinationInTransaction,
    readPortableCompletedRunInTransaction,
    type PostgreSqlPortableDestinationInput,
} from '../storage/postgresql/portable-destination.js';
import type { PostgreSqlTransactionScopeExecutor } from '../storage/postgresql/contracts.js';
import type { PortableBatch, PortableRecordStream } from '../storage/portable-record-stream.js';
import type { PortableDestinationVerification } from '../storage/portable-transfer.js';

export interface MigrationCopyLimitsInput {
    readonly maxRecords: number;
    readonly maxBytes: number;
    readonly leaseTtlMs?: number;
    readonly maximumTransactionAttempts?: number;
}

export function migrationCopyLimits(input: MigrationCopyLimitsInput) {
    const result = {
        maxRecords: input.maxRecords,
        maxBytes: input.maxBytes,
        leaseTtlMs: input.leaseTtlMs ?? 300000,
        maximumTransactionAttempts: input.maximumTransactionAttempts ?? 3,
    };
    const bounds: ReadonlyArray<readonly [value: number, min: number, max: number]> = [
        [result.maxRecords, 1, 500],
        [result.maxBytes, 1, 150994944],
        [result.leaseTtlMs, 1000, 86400000],
        [result.maximumTransactionAttempts, 1, 10],
    ];
    for (const [value, min, max] of bounds) {
        if (!Number.isSafeInteger(value) || value < min || value > max)
            throw new Error('migration copy limits are invalid');
    }
    return result;
}

/** A budget belongs to the logical operation, including authoritative readbacks. */
export async function settleMigrationCopyOperation<T>(input: {
    maximumTransactionAttempts: number;
    mutate: () => Promise<void>;
    readback: () => Promise<T | null>;
    reconnect: () => Promise<void>;
}): Promise<T> {
    let proofRequired = false;
    let primary: unknown;
    for (let attempt = 0; attempt < input.maximumTransactionAttempts; attempt++) {
        if (proofRequired) {
            try {
                const proof = await input.readback();
                if (proof !== null)
                    return proof;
                proofRequired = false;
            }
            catch (error) {
                primary ??= error;
                try {
                    await input.reconnect();
                }
                catch {
                    throw primary;
                }
            }
        }
        else {
            try {
                await input.mutate();
                proofRequired = true;
            }
            catch (error) {
                primary = error;
                if (error instanceof PostgreSqlCommitOutcomeUnknownError) {
                    proofRequired = true;
                    try {
                        await input.reconnect();
                    }
                    catch {
                        throw primary;
                    }
                }
                else {
                    const retryableSqlState = error instanceof PostgreSqlStorageOperationError
                        && ['40001', '40P01'].includes(error.sqlState ?? '');
                    if (!retryableSqlState) throw error;
                }
            }
        }
    }
    throw primary ?? new Error('migration copy requires authoritative readback');
}

export interface MigrationCopyDestinationInput extends PostgreSqlPortableDestinationInput {
    readonly source: PortableRecordStream;
    readonly ownerProcessId: string;
    readonly leaseTtlMs: number;
    readonly maximumTransactionAttempts: number;
    readonly withSourceAuthority: <T>(operation: (reauthenticate: () => Promise<void>) => Promise<T>) => Promise<T>;
}

/** Private writer owns the transfer lock/index; runtime owns every fenced SQL effect. */
export async function openMigrationCopyDestination(input: MigrationCopyDestinationInput) {
    const writer = await createPostgreSqlPortableDestination(input);
    let runtime: PostgreSqlRuntime;
    try {
        runtime = new PostgreSqlRuntime(input.settings);
    }
    catch (error) {
        try {
            await writer.close();
        }
        catch { /* preserve construction failure */ }
        throw error;
    }
    let lease: PostgreSqlFencedLease | null = null;
    const manifest = input.source.describe();
    const resource = {
        resourceType: 'migration-copy',
        resourceKey: 'copy',
        processId: input.ownerProcessId,
        operation: 'migration-copy',
    };
    const context = {
        domain: 'factory' as const,
        operation: 'migrationCopy',
        projectId: input.expectedIdentity.id,
        machineId: input.expectedIdentity.machineId,
    };
    const coordinator = () => new PostgreSqlWorkCoordinator(runtime, input.expectedIdentity.id, input.expectedIdentity.machineId!);
    const reconnect = async () => { await runtime.close(); runtime = new PostgreSqlRuntime(input.settings); };
    const serializeReadback = async <T>(
        read: (executor: PostgreSqlTransactionScopeExecutor) => Promise<T>,
    ): Promise<T> => runtime.transaction(async (executor) => {
        // A readback may observe a committed receipt without acquiring new mutation
        // authority. This row lock waits for the original fenced transaction to settle.
        const locked = await executor.query({
            text: 'SELECT 1 AS locked FROM lcm.fenced_leases WHERE project_id=$1 AND resource_type=$2 AND resource_key=$3 FOR UPDATE',
            values: [input.expectedIdentity.id, resource.resourceType, resource.resourceKey],
        }, context);
        if (locked.rows.length !== 1)
            throw new Error('migration copy lease serialization is unavailable');
        return read(executor);
    }, { ...context, transactionMode: 'read-committed-read-write' });
    const mutate = async <T>(operation: (executor: PostgreSqlTransactionScopeExecutor) => Promise<T>): Promise<T> => {
        const owner = coordinator();
        lease = lease
            ? await owner.renewLease({ ...resource, fencingToken: lease.fencingToken, ttlMs: input.leaseTtlMs, signal: input.signal })
            : null;
        lease ??= await owner.acquireLease({ ...resource, ttlMs: input.leaseTtlMs, signal: input.signal });
        if (!lease)
            throw new Error('migration copy lease is owned by another worker');
        const fence = { ...resource, fencingToken: lease.fencingToken, signal: input.signal };
        return input.withSourceAuthority(reauthenticate => runtime.transaction(async (executor) => {
            const scoped = new PostgreSqlWorkCoordinator(executor, input.expectedIdentity.id, input.expectedIdentity.machineId!);
            await scoped.assertLeaseFence(fence);
            await reauthenticate();
            const result = await operation(executor);
            await reauthenticate();
            await scoped.assertLeaseFence(fence);
            return result;
        }, { ...context, transactionMode: 'read-committed-read-write', signal: input.signal }));
    };
    try {
        const token = await writer.preflight(manifest, input.source, input.signal);
        const readRun = () => serializeReadback(executor => readPortableRunInTransaction(executor, writer, manifest, token));
        const readBatch = (batch: PortableBatch) => serializeReadback(
            executor => readPortableBatchReceiptInTransaction(executor, writer, batch),
        );
        return {
            async admit(requireExisting: boolean) {
                if (requireExisting) {
                    if (!await readRun())
                        throw new Error('migration copy run is missing');
                    return;
                }
                await settleMigrationCopyOperation({
                    maximumTransactionAttempts: input.maximumTransactionAttempts,
                    reconnect,
                    mutate: () => mutate(executor => admitPortableDestinationInTransaction(executor, writer, manifest, token, input.signal)),
                    readback: readRun,
                });
            },
            readBatch,
            async applyBatch(batch: PortableBatch) {
                return settleMigrationCopyOperation({
                    maximumTransactionAttempts: input.maximumTransactionAttempts,
                    reconnect,
                    mutate: async () => { await mutate(executor => applyPortableBatchInTransaction(executor, writer, batch, input.signal)); },
                    readback: () => readBatch(batch),
                });
            },
            verify: () => verifyPortableDestinationComplete(writer, manifest, input.signal),
            async complete(verification: PortableDestinationVerification) {
                await settleMigrationCopyOperation({
                    maximumTransactionAttempts: input.maximumTransactionAttempts,
                    reconnect,
                    mutate: () => mutate(executor => completePortableDestinationInTransaction(executor, writer, verification, input.signal)),
                    readback: async () => {
                        const completed = await serializeReadback(
                            executor => readPortableCompletedRunInTransaction(executor, writer, verification),
                        );
                        return completed ? true : null;
                    },
                });
            },
            async readCompleted(verification: PortableDestinationVerification) {
                return serializeReadback(executor => readPortableCompletedRunInTransaction(executor, writer, verification));
            },
            async close() {
                let primary: unknown;
                try {
                    if (lease)
                        await coordinator().releaseLease({ ...resource, fencingToken: lease.fencingToken });
                }
                catch (error) {
                    primary = error;
                }
                try {
                    await runtime.close();
                }
                catch (error) {
                    primary ??= error;
                }
                try {
                    await writer.close();
                }
                catch (error) {
                    primary ??= error;
                }
                if (primary !== undefined)
                    throw primary;
            },
        };
    }
    catch (error) {
        await runtime.close().catch(() => undefined);
        await writer.close().catch(() => undefined);
        throw error;
    }
}
