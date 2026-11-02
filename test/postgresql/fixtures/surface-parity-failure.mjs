import { createHash } from 'node:crypto';
import { AssertionError } from 'node:assert/strict';

const sourceLabels = new Map([
  ['surface-parity-worker.mjs', 'wk'], ['surface-parity-workflows.mjs', 'wf'],
  ['surface-parity-imports.mjs', 'im'], ['surface-parity-faults.mjs', 'ft'],
  ['prepared-projects.mjs', 'pp'], ['prepared-journals.mjs', 'pj'],
  ['assertions.mjs', 'as'], ['async-isolation.mjs', 'ai'],
  ['native-observer.mjs', 'no'], ['backend-observation.mjs', 'bo'],
  ['cli-json.mjs', 'cj'], ['passive-leases.mjs', 'pl'],
]);
const assertionOperators = new Map([
  ['==', 'eq'], ['!=', 'ne'], ['===', 'seq'], ['!==', 'sne'],
  ['strictEqual', 'seq'], ['notStrictEqual', 'sne'],
  ['deepEqual', 'deq'], ['notDeepEqual', 'dne'],
  ['deepStrictEqual', 'dseq'], ['notDeepStrictEqual', 'dsne'],
  ['fail', 'fail'], ['match', 'match'], ['doesNotMatch', 'nomatch'], ['ifError', 'iferr'],
]);

function sourceFrame(error) {
  const stack = String(error?.stack ?? '').slice(0, 16_384);
  for (const frame of stack.split('\n')) {
    if (!/^\s*at\s/u.test(frame)) continue;
    for (const match of frame.matchAll(/(?:^|[\u002f\\(\s])([a-zA-Z0-9_-]+\.mjs):([0-9]+):[0-9]+(?=$|[\s)])/gu)) {
      const label = sourceLabels.get(match[1]);
      const line = Number(match[2]);
      if (label && Number.isSafeInteger(line) && line > 0 && line <= 100_000) return `:${label}${line}`;
    }
  }
  return '';
}

export function failure(error, preparedFailureContext) {
  const message = String(error?.message ?? error);
  const symbolic = message.match(/^(?:surface[-\w]*:)[a-zA-Z0-9:._-]+/u)?.[0];
  const knownNames = new Set(['ConfigValidationError', 'BackendPublicationJournalError', 'PrivateMutationLockContentionError', 'TypeError', 'SyntaxError', 'StorageOperationError', 'PostgreSqlStorageOperationError']);
  const errorName = knownNames.has(error?.name) ? error.name : knownNames.has(error?.constructor?.name) ? error.constructor.name : undefined;
  const knownCodes = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EBADF', 'EBUSY', 'EAGAIN', 'ESTALE', 'ERR_INVALID_STATE', 'ERR_INVALID_ARG_TYPE', 'ERR_SQLITE_ERROR']);
  const assertion = error instanceof AssertionError && error.code === 'ERR_ASSERTION';
  const fallbackId = errorName ? `surface-worker:${errorName}` : knownCodes.has(error?.code) ? `surface-worker:${error.code}`
    : error instanceof Error && !assertion ? 'surface-worker:Error' : 'surface-worker:assertion';
  const kind = assertion ? `:a-${assertionOperators.get(error.operator) ?? 'other'}` : ':err';
  const booleans = assertion && typeof error.actual === 'boolean' && typeof error.expected === 'boolean'
    ? `:b${Number(error.actual)}${Number(error.expected)}` : '';
  const diagnostic = `${kind}${sourceFrame(error)}${booleans}`;
  const field = typeof error?.surfacePreparedField === 'string' && /^[a-zA-Z.]{1,64}$/u.test(error.surfacePreparedField) ? `:${error.surfacePreparedField}` : '';
  const detail = preparedFailureContext ? `${preparedFailureContext}:${(symbolic ?? fallbackId).replace(/^surface[-\w]*:/u, '')}${field}`
    : symbolic ?? fallbackId;
  return { id: `${detail.slice(0, 110 - diagnostic.length)}${diagnostic}`, digest: error?.surfaceEvidence?.stdoutErrorDigest ?? error?.surfaceEvidence?.stderrDigest ?? createHash('sha256').update(message).digest('hex') };
}
