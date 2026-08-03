//! Read-only admission of the exact stable no-daemon layout.
//!
//! This module is deliberately private and is not wired to the executable. Admission only retains
//! descriptor authority and the serial OFD lock; it has no mutation, process, signal, or network
//! capability.

use crate::descriptor::{
    Descriptor, DescriptorError, DescriptorIdentity, DescriptorKind, DescriptorPolicy,
};
use crate::persistence::{
    HeldRecord, LayoutState, PersistenceError, RecordName, RecordStore, SerialLock, classify_layout,
};
use crate::record::{Authority, RecordBody, RecordKind, StableDirectoryIdentity, TokenKey};
use crate::syscall::{self, Errno, OpenAccess};
use core::fmt;

const TOKEN_BYTES: usize = 64;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct PreverifiedHelperDigest([u8; 32]);

impl PreverifiedHelperDigest {
    pub(crate) const fn new(digest: [u8; 32]) -> Self {
        Self(digest)
    }
}

#[derive(Debug)]
pub(crate) struct StableVacantLease {
    _state_root: Descriptor,
    _recovery_root: Descriptor,
    _token: HeldToken,
    _pid: HeldRecord,
    _lifecycle: HeldRecord,
    _restart: HeldRecord,
    _launch: HeldRecord,
    _serial: SerialLock,
}

struct HeldToken {
    descriptor: Descriptor,
    identity: DescriptorIdentity,
    canonical: [u8; TOKEN_BYTES],
    key: TokenKey,
}

impl fmt::Debug for HeldToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HeldToken")
            .field("descriptor", &self.descriptor)
            .field("identity", &self.identity)
            .field("canonical", &"[REDACTED]")
            .field("key", &self.key)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum StableAdmissionError {
    Syscall(Errno),
    Descriptor(DescriptorError),
    Persistence(PersistenceError),
    InvalidToken,
    AuthorityMismatch,
    LayoutNotStable,
    Replacement,
}

pub(crate) fn admit_stable_vacant(
    state_root: Descriptor,
    owner_uid: u32,
    owner_gid: u32,
    helper_digest: PreverifiedHelperDigest,
) -> Result<StableVacantLease, StableAdmissionError> {
    admit_stable_vacant_with_postcheck(state_root, owner_uid, owner_gid, helper_digest, || {})
}

fn admit_stable_vacant_with_postcheck(
    state_root: Descriptor,
    owner_uid: u32,
    owner_gid: u32,
    helper_digest: PreverifiedHelperDigest,
    before_postcheck: impl FnOnce(),
) -> Result<StableVacantLease, StableAdmissionError> {
    let directory_policy = directory_policy(owner_uid, owner_gid);
    let state_identity = stable_identity(
        state_root
            .validate(directory_policy)
            .map_err(StableAdmissionError::Descriptor)?,
    )?;

    let token = open_token(&state_root, owner_uid, owner_gid)?;
    let recovery_root = syscall::open_beneath(
        state_root.as_fd(),
        c"daemon-recovery.v1",
        OpenAccess::ReadOnly { directory: true },
    )
    .map_err(StableAdmissionError::Syscall)?;
    let recovery_identity = stable_identity(
        recovery_root
            .validate(directory_policy)
            .map_err(StableAdmissionError::Descriptor)?,
    )?;
    let authority = Authority {
        state_root: state_identity,
        recovery_root: recovery_identity,
        helper_digest: helper_digest.0,
    };
    let store = RecordStore::new(owner_uid, owner_gid);

    // The serial descriptor is opened and locked before any recovery-root child-name inspection.
    let serial = store
        .open(
            &recovery_root,
            RecordName::LifecycleSerial,
            RecordKind::LifecycleSerial,
            &token.key,
        )
        .map_err(StableAdmissionError::Persistence)?;
    if !serial_has_authority(&serial, authority) {
        return Err(StableAdmissionError::AuthorityMismatch);
    }
    let serial = SerialLock::acquire(serial).map_err(StableAdmissionError::Persistence)?;

    let layout = store
        .load_layout_after_lock(&recovery_root, &serial, &token.key)
        .map_err(StableAdmissionError::Persistence)?;
    if classify_layout(&layout) != LayoutState::StableEmpty {
        return Err(StableAdmissionError::LayoutNotStable);
    }
    let lifecycle = open_stable_vacancy(
        &store,
        &recovery_root,
        RecordName::LifecycleCurrent,
        RecordKind::LifecycleVacant,
        authority,
        serial.record().identity,
        &token.key,
    )?;
    let restart = open_stable_vacancy(
        &store,
        &recovery_root,
        RecordName::RestartCurrent,
        RecordKind::RestartVacant,
        authority,
        serial.record().identity,
        &token.key,
    )?;
    let launch = open_stable_vacancy(
        &store,
        &recovery_root,
        RecordName::LaunchCurrent,
        RecordKind::LaunchVacant,
        authority,
        serial.record().identity,
        &token.key,
    )?;

    let pid = store
        .open(
            &state_root,
            RecordName::DaemonPid,
            RecordKind::PidVacant,
            &token.key,
        )
        .map_err(StableAdmissionError::Persistence)?;
    if !vacancy_has_authority(&pid, authority, serial.record().identity) {
        return Err(StableAdmissionError::AuthorityMismatch);
    }

    before_postcheck();

    revalidate_directory(&state_root, state_identity, directory_policy)?;
    revalidate_recovery(
        &state_root,
        &recovery_root,
        recovery_identity,
        directory_policy,
    )?;
    revalidate_token(&state_root, &token, owner_uid, owner_gid)?;
    revalidate_record_path(
        &store,
        &state_root,
        RecordName::DaemonPid,
        RecordKind::PidVacant,
        &pid,
        &token.key,
    )?;
    for (name, held) in [
        (RecordName::LifecycleCurrent, &lifecycle),
        (RecordName::RestartCurrent, &restart),
        (RecordName::LaunchCurrent, &launch),
    ] {
        revalidate_record_path(
            &store,
            &recovery_root,
            name,
            held.record.kind,
            held,
            &token.key,
        )?;
    }

    // Reloading last revalidates the locked serial path, serial descriptor, root names, all three
    // recovery vacancies, launch vacancy, zero terminal slots, and recovery-root identity.
    let post_layout = store
        .load_layout_after_lock(&recovery_root, &serial, &token.key)
        .map_err(|_| StableAdmissionError::Replacement)?;
    if classify_layout(&post_layout) != LayoutState::StableEmpty
        || !serial_has_authority(serial.record(), authority)
    {
        return Err(StableAdmissionError::Replacement);
    }
    Ok(StableVacantLease {
        _state_root: state_root,
        _recovery_root: recovery_root,
        _token: token,
        _pid: pid,
        _lifecycle: lifecycle,
        _restart: restart,
        _launch: launch,
        _serial: serial,
    })
}

fn open_stable_vacancy(
    store: &RecordStore,
    recovery_root: &Descriptor,
    name: RecordName,
    kind: RecordKind,
    authority: Authority,
    serial: crate::record::StrictLeafIdentity,
    key: &TokenKey,
) -> Result<HeldRecord, StableAdmissionError> {
    let held = store
        .open(recovery_root, name, kind, key)
        .map_err(|_| StableAdmissionError::Replacement)?;
    if !vacancy_has_authority(&held, authority, serial) {
        return Err(StableAdmissionError::Replacement);
    }
    Ok(held)
}

fn open_token(
    state_root: &Descriptor,
    owner_uid: u32,
    owner_gid: u32,
) -> Result<HeldToken, StableAdmissionError> {
    let descriptor = syscall::open_beneath(
        state_root.as_fd(),
        c"daemon.token",
        OpenAccess::ReadOnly { directory: false },
    )
    .map_err(StableAdmissionError::Syscall)?;
    let identity = descriptor
        .validate(token_policy(owner_uid, owner_gid))
        .map_err(StableAdmissionError::Descriptor)?;
    let bytes = descriptor
        .read_bounded(TOKEN_BYTES)
        .map_err(StableAdmissionError::Descriptor)?;
    let canonical: [u8; TOKEN_BYTES] = bytes
        .try_into()
        .map_err(|_| StableAdmissionError::InvalidToken)?;
    let key = TokenKey::parse(&canonical).map_err(|_| StableAdmissionError::InvalidToken)?;
    Ok(HeldToken {
        descriptor,
        identity,
        canonical,
        key,
    })
}

fn revalidate_token(
    state_root: &Descriptor,
    held: &HeldToken,
    owner_uid: u32,
    owner_gid: u32,
) -> Result<(), StableAdmissionError> {
    validate_token_descriptor(held, owner_uid, owner_gid)?;
    let reopened = open_token(state_root, owner_uid, owner_gid)
        .map_err(|_| StableAdmissionError::Replacement)?;
    if reopened.identity != held.identity || reopened.canonical != held.canonical {
        return Err(StableAdmissionError::Replacement);
    }
    Ok(())
}

fn validate_token_descriptor(
    held: &HeldToken,
    owner_uid: u32,
    owner_gid: u32,
) -> Result<(), StableAdmissionError> {
    let identity = held
        .descriptor
        .validate(token_policy(owner_uid, owner_gid))
        .map_err(|_| StableAdmissionError::Replacement)?;
    let bytes = held
        .descriptor
        .read_bounded(TOKEN_BYTES)
        .map_err(|_| StableAdmissionError::Replacement)?;
    if identity != held.identity || bytes != held.canonical {
        return Err(StableAdmissionError::Replacement);
    }
    Ok(())
}

fn revalidate_record_path(
    store: &RecordStore,
    parent: &Descriptor,
    name: RecordName,
    kind: RecordKind,
    held: &HeldRecord,
    key: &TokenKey,
) -> Result<(), StableAdmissionError> {
    store
        .revalidate(held)
        .map_err(|_| StableAdmissionError::Replacement)?;
    let reopened = store
        .open(parent, name, kind, key)
        .map_err(|_| StableAdmissionError::Replacement)?;
    if reopened.identity != held.identity || reopened.record != held.record {
        return Err(StableAdmissionError::Replacement);
    }
    Ok(())
}

fn revalidate_directory(
    descriptor: &Descriptor,
    expected: StableDirectoryIdentity,
    policy: DescriptorPolicy,
) -> Result<(), StableAdmissionError> {
    let observed = descriptor
        .validate(policy)
        .map_err(|_| StableAdmissionError::Replacement)?;
    if stable_identity(observed)? != expected {
        return Err(StableAdmissionError::Replacement);
    }
    Ok(())
}

fn revalidate_recovery(
    state_root: &Descriptor,
    held: &Descriptor,
    expected: StableDirectoryIdentity,
    policy: DescriptorPolicy,
) -> Result<(), StableAdmissionError> {
    revalidate_directory(held, expected, policy)?;
    let reopened = syscall::open_beneath(
        state_root.as_fd(),
        c"daemon-recovery.v1",
        OpenAccess::ReadOnly { directory: true },
    )
    .map_err(|_| StableAdmissionError::Replacement)?;
    revalidate_directory(&reopened, expected, policy)
}

fn serial_has_authority(serial: &HeldRecord, expected: Authority) -> bool {
    matches!(serial.record.body, RecordBody::Serial(body) if body.authority == expected)
}

fn vacancy_has_authority(
    vacancy: &HeldRecord,
    expected: Authority,
    serial: crate::record::StrictLeafIdentity,
) -> bool {
    matches!(
        vacancy.record.body,
        RecordBody::Vacancy(body) if body.authority == expected && body.serial == serial
    )
}

fn stable_identity(
    identity: DescriptorIdentity,
) -> Result<StableDirectoryIdentity, StableAdmissionError> {
    let DescriptorIdentity::StableDirectory(common) = identity else {
        return Err(StableAdmissionError::Replacement);
    };
    Ok(StableDirectoryIdentity {
        device: common.device,
        inode: common.inode,
        uid: common.uid,
        gid: common.gid,
        mode: common.mode,
    })
}

const fn directory_policy(owner_uid: u32, owner_gid: u32) -> DescriptorPolicy {
    DescriptorPolicy {
        kind: DescriptorKind::Directory,
        owner_uid,
        owner_gid,
        exact_mode: 0o700,
        require_single_link: false,
        max_size: None,
    }
}

const fn token_policy(owner_uid: u32, owner_gid: u32) -> DescriptorPolicy {
    DescriptorPolicy {
        kind: DescriptorKind::RegularFile,
        owner_uid,
        owner_gid,
        exact_mode: 0o600,
        require_single_link: true,
        max_size: Some(TOKEN_BYTES as u64),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::RecordStore;
    use crate::record::{
        AuthenticatedRecord, RecordBody, SerialRecord, StrictLeafIdentity, VacancyRecord,
    };
    use std::collections::BTreeMap;
    use std::fs::{self, File, OpenOptions};
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt, symlink};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NONCE: AtomicU64 = AtomicU64::new(0);
    const HELPER_DIGEST: [u8; 32] = [0x44; 32];
    const TOKEN: [u8; 64] = [b'a'; 64];

    struct Fixture {
        root: PathBuf,
        owner_uid: u32,
        owner_gid: u32,
        authority: Authority,
        serial_identity: StrictLeafIdentity,
    }

    impl Fixture {
        fn new() -> Self {
            Self::new_with_serial_authority(|_| {})
        }

        fn new_with_serial_authority(mut alter: impl FnMut(&mut Authority)) -> Self {
            let root = temporary_path("fixture");
            fs::create_dir(&root).unwrap();
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            write_new(&root.join("daemon.token"), &TOKEN);
            let recovery = root.join("daemon-recovery.v1");
            fs::create_dir(&recovery).unwrap();
            fs::set_permissions(&recovery, fs::Permissions::from_mode(0o700)).unwrap();

            let root_metadata = fs::metadata(&root).unwrap();
            let recovery_metadata = fs::metadata(&recovery).unwrap();
            let owner_uid = root_metadata.uid();
            let owner_gid = root_metadata.gid();
            let authority = Authority {
                state_root: identity_from_metadata(&root_metadata),
                recovery_root: identity_from_metadata(&recovery_metadata),
                helper_digest: HELPER_DIGEST,
            };
            let mut serial_authority = authority;
            alter(&mut serial_authority);
            let key = TokenKey::parse(&TOKEN).unwrap();
            let store = RecordStore::new(owner_uid, owner_gid);
            let recovery_descriptor = Descriptor::from_file(File::open(&recovery).unwrap());
            let serial = store
                .create_serial_exclusive(&recovery_descriptor, serial_authority, &key)
                .unwrap();
            let serial_identity = serial.identity;
            drop(serial);
            for (name, kind) in [
                (RecordName::LifecycleCurrent, RecordKind::LifecycleVacant),
                (RecordName::RestartCurrent, RecordKind::RestartVacant),
                (RecordName::LaunchCurrent, RecordKind::LaunchVacant),
            ] {
                store
                    .create_exclusive(
                        &recovery_descriptor,
                        name,
                        vacancy(kind, serial_authority, serial_identity, &key),
                        &key,
                    )
                    .unwrap();
            }
            let state_descriptor = Descriptor::from_file(File::open(&root).unwrap());
            store
                .create_exclusive(
                    &state_descriptor,
                    RecordName::DaemonPid,
                    vacancy(
                        RecordKind::PidVacant,
                        serial_authority,
                        serial_identity,
                        &key,
                    ),
                    &key,
                )
                .unwrap();
            Self {
                root,
                owner_uid,
                owner_gid,
                authority,
                serial_identity,
            }
        }

        fn admit(&self) -> Result<StableVacantLease, StableAdmissionError> {
            admit_stable_vacant(
                Descriptor::from_file(File::open(&self.root).unwrap()),
                self.owner_uid,
                self.owner_gid,
                PreverifiedHelperDigest::new(HELPER_DIGEST),
            )
        }

        fn admit_with_hook(
            &self,
            hook: impl FnOnce(),
        ) -> Result<StableVacantLease, StableAdmissionError> {
            admit_stable_vacant_with_postcheck(
                Descriptor::from_file(File::open(&self.root).unwrap()),
                self.owner_uid,
                self.owner_gid,
                PreverifiedHelperDigest::new(HELPER_DIGEST),
                hook,
            )
        }

        fn recovery(&self) -> PathBuf {
            self.root.join("daemon-recovery.v1")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).unwrap();
        }
    }

    fn temporary_path(label: &str) -> PathBuf {
        let time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let nonce = NONCE.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "lcm-helper-stable-{label}-{}-{time}-{nonce}",
            std::process::id()
        ))
    }

    fn identity_from_metadata(metadata: &fs::Metadata) -> StableDirectoryIdentity {
        StableDirectoryIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
            uid: metadata.uid(),
            gid: metadata.gid(),
            mode: metadata.mode() & 0o7777,
        }
    }

    fn vacancy(
        kind: RecordKind,
        authority: Authority,
        serial: StrictLeafIdentity,
        key: &TokenKey,
    ) -> AuthenticatedRecord {
        AuthenticatedRecord::encode(
            kind,
            RecordBody::Vacancy(VacancyRecord { authority, serial }),
            key,
        )
        .unwrap()
    }

    fn write_new(path: &Path, bytes: &[u8]) {
        use std::io::Write;
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(path)
            .unwrap();
        file.write_all(bytes).unwrap();
        file.sync_all().unwrap();
    }

    fn overwrite(path: &Path, bytes: &[u8]) {
        use std::io::Write;
        let mut file = OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(path)
            .unwrap();
        file.write_all(bytes).unwrap();
        file.sync_all().unwrap();
    }

    fn replace_file(path: &Path, bytes: &[u8]) {
        let replacement = path.with_extension(format!(
            "replacement-{}",
            NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        write_new(&replacement, bytes);
        fs::rename(replacement, path).unwrap();
    }

    fn tree_bytes(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        fn visit(root: &Path, path: &Path, output: &mut BTreeMap<PathBuf, Vec<u8>>) {
            let mut entries: Vec<_> = fs::read_dir(path)
                .unwrap()
                .map(|entry| entry.unwrap())
                .collect();
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries {
                let entry_path = entry.path();
                let relative = entry_path.strip_prefix(root).unwrap().to_path_buf();
                let file_type = entry.file_type().unwrap();
                if file_type.is_dir() {
                    output.insert(relative.clone(), b"directory".to_vec());
                    visit(root, &entry_path, output);
                } else if file_type.is_file() {
                    output.insert(relative, fs::read(entry_path).unwrap());
                } else {
                    output.insert(relative, b"other".to_vec());
                }
            }
        }
        let mut output = BTreeMap::new();
        visit(root, root, &mut output);
        output
    }

    #[test]
    fn seeded_stable_state_admits_without_durable_mutation_and_retains_lock() {
        let fixture = Fixture::new();
        let before = tree_bytes(&fixture.root);
        let lease = fixture.admit().unwrap();
        assert_eq!(tree_bytes(&fixture.root), before);

        let key = TokenKey::parse(&TOKEN).unwrap();
        let store = RecordStore::new(fixture.owner_uid, fixture.owner_gid);
        let recovery = Descriptor::from_file(File::open(fixture.recovery()).unwrap());
        let competing_serial = store
            .open(
                &recovery,
                RecordName::LifecycleSerial,
                RecordKind::LifecycleSerial,
                &key,
            )
            .unwrap();
        assert!(matches!(
            SerialLock::acquire(competing_serial),
            Err(PersistenceError::Syscall(Errno(11) | Errno(13)))
        ));

        drop(lease);
        assert_eq!(tree_bytes(&fixture.root), before);
        let released_serial = store
            .open(
                &recovery,
                RecordName::LifecycleSerial,
                RecordKind::LifecycleSerial,
                &key,
            )
            .unwrap();
        assert!(SerialLock::acquire(released_serial).is_ok());
    }

    #[test]
    fn token_requires_exact_content_kind_mode_and_single_link() {
        let malformed = Fixture::new();
        overwrite(&malformed.root.join("daemon.token"), &[b'A'; 64]);
        assert!(malformed.admit().is_err());

        let changed = Fixture::new();
        overwrite(&changed.root.join("daemon.token"), &[b'b'; 64]);
        assert!(changed.admit().is_err());

        let linked = Fixture::new();
        fs::hard_link(
            linked.root.join("daemon.token"),
            linked.root.join("token.link"),
        )
        .unwrap();
        assert!(linked.admit().is_err());

        let wrong_mode = Fixture::new();
        fs::set_permissions(
            wrong_mode.root.join("daemon.token"),
            fs::Permissions::from_mode(0o640),
        )
        .unwrap();
        assert!(wrong_mode.admit().is_err());

        let symbolic = Fixture::new();
        fs::rename(
            symbolic.root.join("daemon.token"),
            symbolic.root.join("token.target"),
        )
        .unwrap();
        symlink("token.target", symbolic.root.join("daemon.token")).unwrap();
        assert!(symbolic.admit().is_err());
    }

    #[test]
    fn pid_requires_the_exact_authenticated_vacancy() {
        let missing = Fixture::new();
        fs::remove_file(missing.root.join("daemon.pid")).unwrap();
        assert!(missing.admit().is_err());

        let numeric = Fixture::new();
        overwrite(&numeric.root.join("daemon.pid"), b"12345\n");
        assert!(numeric.admit().is_err());

        let wrong_kind = Fixture::new();
        let key = TokenKey::parse(&TOKEN).unwrap();
        let lifecycle = vacancy(
            RecordKind::LifecycleVacant,
            wrong_kind.authority,
            wrong_kind.serial_identity,
            &key,
        );
        overwrite(
            &wrong_kind.root.join("daemon.pid"),
            lifecycle.canonical_bytes(),
        );
        assert!(wrong_kind.admit().is_err());

        let bad_mac = Fixture::new();
        let mut bytes = fs::read(bad_mac.root.join("daemon.pid")).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        overwrite(&bad_mac.root.join("daemon.pid"), &bytes);
        assert!(bad_mac.admit().is_err());

        let substituted = Fixture::new();
        let replacement = vacancy(
            RecordKind::PidVacant,
            substituted.authority,
            StrictLeafIdentity {
                inode: substituted.serial_identity.inode + 1,
                ..substituted.serial_identity
            },
            &key,
        );
        overwrite(
            &substituted.root.join("daemon.pid"),
            replacement.canonical_bytes(),
        );
        assert!(substituted.admit().is_err());
    }

    #[test]
    fn every_authority_field_is_bound_in_serial_and_all_vacancies() {
        for alter in [
            |authority: &mut Authority| authority.state_root.inode += 1,
            |authority: &mut Authority| authority.recovery_root.inode += 1,
            |authority: &mut Authority| authority.helper_digest[0] ^= 1,
        ] {
            let fixture = Fixture::new_with_serial_authority(alter);
            assert_eq!(
                fixture.admit().err(),
                Some(StableAdmissionError::AuthorityMismatch)
            );
        }

        for (under_state_root, component, kind) in [
            (true, "daemon.pid", RecordKind::PidVacant),
            (false, "lifecycle.current.v1", RecordKind::LifecycleVacant),
            (false, "restart.current.v1", RecordKind::RestartVacant),
            (false, "daemon.launch.current.v1", RecordKind::LaunchVacant),
        ] {
            for alter in [
                |authority: &mut Authority| authority.state_root.inode += 1,
                |authority: &mut Authority| authority.recovery_root.inode += 1,
                |authority: &mut Authority| authority.helper_digest[0] ^= 1,
            ] {
                let fixture = Fixture::new();
                let mut authority = fixture.authority;
                alter(&mut authority);
                let key = TokenKey::parse(&TOKEN).unwrap();
                let record = vacancy(kind, authority, fixture.serial_identity, &key);
                let parent = if under_state_root {
                    fixture.root.clone()
                } else {
                    fixture.recovery()
                };
                overwrite(&parent.join(component), record.canonical_bytes());
                assert!(fixture.admit().is_err());
            }
        }
    }

    #[test]
    fn recovery_layout_must_be_precisely_stable_empty() {
        let extra = Fixture::new();
        write_new(&extra.recovery().join("unexpected"), b"x");
        assert!(extra.admit().is_err());

        let missing = Fixture::new();
        fs::remove_file(missing.recovery().join("restart.current.v1")).unwrap();
        assert!(missing.admit().is_err());

        let terminal = Fixture::new();
        fs::create_dir(terminal.recovery().join("terminal.0.v1")).unwrap();
        fs::set_permissions(
            terminal.recovery().join("terminal.0.v1"),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        assert!(terminal.admit().is_err());

        let wrong_launch = Fixture::new();
        let key = TokenKey::parse(&TOKEN).unwrap();
        let wrong = vacancy(
            RecordKind::RestartVacant,
            wrong_launch.authority,
            wrong_launch.serial_identity,
            &key,
        );
        overwrite(
            &wrong_launch.recovery().join("daemon.launch.current.v1"),
            wrong.canonical_bytes(),
        );
        assert!(wrong_launch.admit().is_err());
    }

    #[test]
    fn deterministic_postcheck_races_refuse_every_replaced_authority() {
        let state_mode = Fixture::new();
        assert_eq!(
            state_mode
                .admit_with_hook(|| {
                    fs::set_permissions(&state_mode.root, fs::Permissions::from_mode(0o750))
                        .unwrap();
                })
                .err(),
            Some(StableAdmissionError::Replacement)
        );

        let recovery = Fixture::new();
        assert_eq!(
            recovery
                .admit_with_hook(|| {
                    fs::rename(recovery.recovery(), recovery.root.join("recovery.old")).unwrap();
                    fs::create_dir(recovery.recovery()).unwrap();
                    fs::set_permissions(recovery.recovery(), fs::Permissions::from_mode(0o700))
                        .unwrap();
                })
                .err(),
            Some(StableAdmissionError::Replacement)
        );

        let token = Fixture::new();
        assert_eq!(
            token
                .admit_with_hook(|| {
                    replace_file(&token.root.join("daemon.token"), &TOKEN);
                })
                .err(),
            Some(StableAdmissionError::Replacement)
        );

        let pid = Fixture::new();
        let pid_bytes = fs::read(pid.root.join("daemon.pid")).unwrap();
        assert_eq!(
            pid.admit_with_hook(|| {
                replace_file(&pid.root.join("daemon.pid"), &pid_bytes);
            })
            .err(),
            Some(StableAdmissionError::Replacement)
        );

        let serial = Fixture::new();
        let serial_path = serial.recovery().join("lifecycle.serial.v1");
        let serial_bytes = fs::read(&serial_path).unwrap();
        assert_eq!(
            serial
                .admit_with_hook(|| replace_file(&serial_path, &serial_bytes))
                .err(),
            Some(StableAdmissionError::Replacement)
        );

        for component in [
            "lifecycle.current.v1",
            "restart.current.v1",
            "daemon.launch.current.v1",
        ] {
            let vacancy = Fixture::new();
            let vacancy_path = vacancy.recovery().join(component);
            let vacancy_bytes = fs::read(&vacancy_path).unwrap();
            assert_eq!(
                vacancy
                    .admit_with_hook(|| replace_file(&vacancy_path, &vacancy_bytes))
                    .err(),
                Some(StableAdmissionError::Replacement)
            );
        }
    }

    #[test]
    fn state_recovery_and_pid_metadata_changes_fail_closed() {
        let recovery_mode = Fixture::new();
        fs::set_permissions(recovery_mode.recovery(), fs::Permissions::from_mode(0o750)).unwrap();
        assert!(recovery_mode.admit().is_err());

        let pid_link = Fixture::new();
        fs::hard_link(
            pid_link.root.join("daemon.pid"),
            pid_link.root.join("pid.link"),
        )
        .unwrap();
        assert!(pid_link.admit().is_err());

        let root_mode = Fixture::new();
        fs::set_permissions(&root_mode.root, fs::Permissions::from_mode(0o750)).unwrap();
        assert!(root_mode.admit().is_err());
    }

    #[test]
    fn vacancy_helper_never_accepts_serial_body_for_pid() {
        let fixture = Fixture::new();
        let key = TokenKey::parse(&TOKEN).unwrap();
        let serial_record = AuthenticatedRecord::encode(
            RecordKind::LifecycleSerial,
            RecordBody::Serial(SerialRecord {
                authority: fixture.authority,
                self_identity: match RecordStore::new(fixture.owner_uid, fixture.owner_gid)
                    .open(
                        &Descriptor::from_file(File::open(fixture.recovery()).unwrap()),
                        RecordName::LifecycleSerial,
                        RecordKind::LifecycleSerial,
                        &key,
                    )
                    .unwrap()
                    .record
                    .body
                {
                    RecordBody::Serial(serial) => serial.self_identity,
                    _ => unreachable!(),
                },
            }),
            &key,
        )
        .unwrap();
        overwrite(
            &fixture.root.join("daemon.pid"),
            serial_record.canonical_bytes(),
        );
        assert!(fixture.admit().is_err());
    }
}
