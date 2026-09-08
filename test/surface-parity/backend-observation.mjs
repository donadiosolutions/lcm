import assert from 'node:assert/strict';

// Match the existing doctor config observer: two admitted, descriptor-bound
// snapshots must agree. This fixture observer never acquires a mutation lock.
export function assertSelectedBackend(options, operations) {
  const { homeDir, configPath, backend, assertNoSqliteFiles } = options;
  const { withReadRoot, readSnapshot, assertReadAccess, witnessEqual } = operations;
  return withReadRoot(homeDir, assertReadRoot => {
    const read = () => {
      assertReadRoot();
      const snapshot = readSnapshot(configPath);
      assertReadRoot();
      assert.equal(snapshot.witness.presence, 'present', 'surface-observer:config-absent');
      assert.equal(snapshot.config.storage.backend, backend, 'surface-observer:selection-changed');
      return snapshot;
    };
    const admit = snapshot => {
      assertReadRoot();
      const admission = assertReadAccess(configPath, backend, snapshot.witness);
      assertReadRoot();
      return admission;
    };
    const first = read();
    const firstAdmission = admit(first);
    if (backend === 'postgresql') {
      assertReadRoot();
      assertNoSqliteFiles();
      assertReadRoot();
    }
    const second = read();
    assert.equal(witnessEqual(first.witness, second.witness), true, 'surface-observer:config-changed');
    const secondAdmission = admit(second);
    assert.equal(firstAdmission.journalChecksumSha256, secondAdmission.journalChecksumSha256,
      'surface-observer:publication-changed');
    return { backend, witness: second.witness, journalChecksumSha256: secondAdmission.journalChecksumSha256 };
  });
}
