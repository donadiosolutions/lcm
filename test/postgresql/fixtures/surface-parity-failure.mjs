import { createHash } from 'node:crypto';

export function failure(error, preparedFailureContext) {
  const message = String(error?.message ?? error);
  const symbolic = message.match(/^(?:surface[-\w]*:)[a-zA-Z0-9:._-]+/u)?.[0];
  const knownNames = new Set(['ConfigValidationError', 'BackendPublicationJournalError', 'PrivateMutationLockContentionError', 'TypeError', 'SyntaxError', 'StorageOperationError', 'PostgreSqlStorageOperationError']);
  const errorName = knownNames.has(error?.name) ? error.name : knownNames.has(error?.constructor?.name) ? error.constructor.name : undefined;
  const knownCodes = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EBADF', 'EBUSY', 'EAGAIN', 'ESTALE', 'ERR_INVALID_STATE', 'ERR_INVALID_ARG_TYPE', 'ERR_SQLITE_ERROR']);
  const fallbackId = errorName ? `surface-worker:${errorName}` : knownCodes.has(error?.code) ? `surface-worker:${error.code}` : 'surface-worker:assertion';
  const frame = String(error?.stack ?? '').match(/(surface-parity-[a-z-]+\.mjs):(\d+):\d+/u);
  const field = typeof error?.surfacePreparedField === 'string' && /^[a-zA-Z.]{1,64}$/u.test(error.surfacePreparedField) ? `:${error.surfacePreparedField}` : '';
  const detail = preparedFailureContext ? `${preparedFailureContext}:${(symbolic ?? fallbackId).replace(/^surface[-\w]*:/u, '')}${field}`
    : `${symbolic ?? fallbackId}${frame ? `:${frame[1]}:${frame[2]}` : ''}`;
  return { id: detail.slice(0, 110), digest: error?.surfaceEvidence?.stdoutErrorDigest ?? error?.surfaceEvidence?.stderrDigest ?? createHash('sha256').update(message).digest('hex') };
}
