import assert from 'node:assert/strict';

function settledSidecars(sidecars) {
  assert.ok(sidecars.every(row => !row.scanError && !row.scanSkipped && row.unprocessed === 0),
    'surface-isolation:passive-work-not-settled');
  // Delivery state is independent of passive promotion. Preserve it, including
  // pending delivery and terminal quarantine; never acknowledge or delete it.
  return sidecars.map(row => ({ projectId: row.projectId, captured: row.captured, unprocessed: row.unprocessed,
    deliveryPending: row.deliveryPending, deliveryClaimed: row.deliveryClaimed, deliveryRetry: row.deliveryRetry,
    deliveryReplicated: row.deliveryReplicated, deliveryAcknowledged: row.deliveryAcknowledged,
    deliveryAwaitingRemotePrune: row.deliveryAwaitingRemotePrune, deliveryQuarantined: row.deliveryQuarantined,
  })).sort((left, right) => left.projectId.localeCompare(right.projectId));
}

// This is fixture settlement after the public row's assertions, not another
// attempt at that public operation. Every setup action executes once.
export async function isolateAsyncBoundary(operations) {
  const initial = await operations.readSidecars();
  assert.ok(initial.every(row => !row.scanError && !row.scanSkipped), 'surface-isolation:sidecar-observation');
  const pending = initial.filter(row => row.unprocessed > 0);
  assert.ok(pending.every(row => !row.metadataMissing && typeof row.cwd === 'string' && row.cwd.length > 0),
    'surface-isolation:pending-owner-missing');
  for (const sidecar of pending) {
    const drained = await operations.drain(sidecar.cwd);
    assert.equal(drained.status, 200, 'surface-isolation:drain-status');
    assert.ok(drained.body.errors === 0 && drained.body.incomplete !== true, 'surface-isolation:drain-incomplete');
  }
  settledSidecars(await operations.readSidecars());
  const previous = await operations.stop();
  const beforeSidecars = settledSidecars(await operations.readSidecars());
  const before = await operations.captureState();
  const current = await operations.start(previous.port);
  assert.ok(current.pid !== previous.pid && current.generation !== previous.generation && current.port === previous.port,
    'surface-isolation:daemon-generation');
  const afterSidecars = settledSidecars(await operations.readSidecars());
  assert.ok(JSON.stringify(afterSidecars) === JSON.stringify(beforeSidecars), 'surface-isolation:delivery-state-changed');
  const after = await operations.captureState();
  operations.assertStateUnchanged(after, before);
}
