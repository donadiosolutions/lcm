//! Descriptor-owned durable record storage and bounded layout classification.

use crate::descriptor::{
    Descriptor, DescriptorError, DescriptorIdentity, DescriptorKind, DescriptorPolicy,
};
use crate::record::{
    AuthenticatedRecord, Authority, JournalRecord, RecordBody, RecordError, RecordKind,
    SelectorRecord, SerialRecord, SerialSelfIdentity, StableDirectoryIdentity, StrictLeafIdentity,
    TokenKey,
};
use crate::syscall::{self, Errno, OpenAccess};
use std::ffi::CStr;
use std::os::fd::AsRawFd;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecordName {
    LifecycleSerial,
    LifecycleCurrent,
    RestartCurrent,
    LaunchCurrent,
    DaemonPid,
    LifecycleExchange,
    JournalExchange,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerminalName {
    Slot0,
    Slot1,
    Slot2,
}

impl TerminalName {
    pub const fn component(self) -> &'static CStr {
        match self {
            Self::Slot0 => c"terminal.0.v1",
            Self::Slot1 => c"terminal.1.v1",
            Self::Slot2 => c"terminal.2.v1",
        }
    }

    pub(crate) const fn from_index(index: usize) -> Self {
        match index {
            0 => Self::Slot0,
            1 => Self::Slot1,
            2 => Self::Slot2,
            _ => unreachable!(),
        }
    }
}

impl RecordName {
    pub const fn component(self) -> &'static CStr {
        match self {
            Self::LifecycleSerial => c"lifecycle.serial.v1",
            Self::LifecycleCurrent => c"lifecycle.current.v1",
            Self::RestartCurrent => c"restart.current.v1",
            Self::LaunchCurrent => c"daemon.launch.current.v1",
            Self::DaemonPid => c"daemon.pid",
            Self::LifecycleExchange => c"lifecycle.exchange",
            Self::JournalExchange => c"journal.exchange",
        }
    }

    pub const fn allows(self, kind: RecordKind) -> bool {
        match self {
            Self::LifecycleSerial => matches!(kind, RecordKind::LifecycleSerial),
            Self::LifecycleCurrent | Self::LifecycleExchange => matches!(
                kind,
                RecordKind::LifecycleVacant | RecordKind::LifecycleSelector
            ),
            Self::RestartCurrent | Self::JournalExchange => {
                matches!(kind, RecordKind::RestartVacant | RecordKind::Journal)
            }
            Self::LaunchCurrent => matches!(kind, RecordKind::LaunchVacant),
            Self::DaemonPid => matches!(kind, RecordKind::PidVacant),
        }
    }
}

#[derive(Debug)]
pub struct HeldRecord {
    descriptor: Descriptor,
    pub identity: StrictLeafIdentity,
    pub record: AuthenticatedRecord,
}

impl HeldRecord {
    pub fn descriptor(&self) -> &Descriptor {
        &self.descriptor
    }
}

#[derive(Clone, Copy, Debug)]
pub struct RecordEndpoint<'a> {
    pub parent: &'a Descriptor,
    pub name: RecordName,
    pub held: &'a HeldRecord,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RecordStore {
    owner_uid: u32,
    owner_gid: u32,
}

impl RecordStore {
    pub const fn new(owner_uid: u32, owner_gid: u32) -> Self {
        Self {
            owner_uid,
            owner_gid,
        }
    }

    pub fn create_exclusive(
        &self,
        parent: &Descriptor,
        name: RecordName,
        record: AuthenticatedRecord,
        key: &TokenKey,
    ) -> Result<HeldRecord, PersistenceError> {
        if record.kind == RecordKind::LifecycleSerial || !name.allows(record.kind) {
            return Err(PersistenceError::UnexpectedKind);
        }
        let descriptor = syscall::create_exclusive(parent.as_fd(), name.component(), 0o600)
            .map_err(PersistenceError::Syscall)?;
        descriptor
            .write_complete_at_start(record.canonical_bytes())
            .map_err(PersistenceError::MutationAmbiguous)?;
        descriptor
            .sync_all()
            .map_err(PersistenceError::MutationAmbiguous)?;
        parent
            .sync_all()
            .map_err(PersistenceError::MutationAmbiguous)?;
        let created_identity = descriptor
            .validate(self.policy(record.kind.maximum_bytes() as u64))
            .map_err(PersistenceError::MutationAmbiguous)?;
        let created_identity = strict_identity(created_identity, record.content_digest)?;
        let reopened = self
            .open(parent, name, record.kind, key)
            .map_err(|_| PersistenceError::MutationAmbiguous(DescriptorError::Io(5)))?;
        if reopened.identity != created_identity
            || reopened.record.content_digest != record.content_digest
        {
            return Err(PersistenceError::IdentityMismatch);
        }
        Ok(reopened)
    }

    /// Creates the self-bound serial record from the inode returned by the
    /// exclusive empty-file creation. A caller cannot precompute or substitute
    /// the serial identity.
    pub fn create_serial_exclusive(
        &self,
        parent: &Descriptor,
        authority: Authority,
        key: &TokenKey,
    ) -> Result<HeldRecord, PersistenceError> {
        let descriptor = syscall::create_exclusive(
            parent.as_fd(),
            RecordName::LifecycleSerial.component(),
            0o600,
        )
        .map_err(PersistenceError::Syscall)?;
        let empty_identity = descriptor
            .validate(self.policy(RecordKind::LifecycleSerial.maximum_bytes() as u64))
            .map_err(PersistenceError::MutationAmbiguous)?;
        let self_identity = serial_self_identity(empty_identity)?;
        let record = AuthenticatedRecord::encode(
            RecordKind::LifecycleSerial,
            RecordBody::Serial(SerialRecord {
                authority,
                self_identity,
            }),
            key,
        )
        .map_err(PersistenceError::Record)?;
        descriptor
            .write_complete_at_start(record.canonical_bytes())
            .map_err(PersistenceError::MutationAmbiguous)?;
        descriptor
            .sync_all()
            .map_err(PersistenceError::MutationAmbiguous)?;
        parent
            .sync_all()
            .map_err(PersistenceError::MutationAmbiguous)?;
        let written_identity = descriptor
            .validate(self.policy(RecordKind::LifecycleSerial.maximum_bytes() as u64))
            .map_err(PersistenceError::MutationAmbiguous)?;
        let written_identity = strict_identity(written_identity, record.content_digest)?;
        if !serial_record_matches_identity(record.body, written_identity) {
            return Err(PersistenceError::IdentityMismatch);
        }
        let reopened = self
            .open(
                parent,
                RecordName::LifecycleSerial,
                RecordKind::LifecycleSerial,
                key,
            )
            .map_err(|_| PersistenceError::MutationAmbiguous(DescriptorError::Io(5)))?;
        if reopened.identity != written_identity
            || reopened.record.content_digest != record.content_digest
        {
            return Err(PersistenceError::IdentityMismatch);
        }
        Ok(reopened)
    }

    pub fn open(
        &self,
        parent: &Descriptor,
        name: RecordName,
        expected_kind: RecordKind,
        key: &TokenKey,
    ) -> Result<HeldRecord, PersistenceError> {
        self.open_allowed(parent, name, &[expected_kind], key)
    }

    fn open_allowed(
        &self,
        parent: &Descriptor,
        name: RecordName,
        allowed_kinds: &[RecordKind],
        key: &TokenKey,
    ) -> Result<HeldRecord, PersistenceError> {
        if allowed_kinds.is_empty() || allowed_kinds.iter().any(|kind| !name.allows(*kind)) {
            return Err(PersistenceError::UnexpectedKind);
        }
        let maximum = allowed_kinds
            .iter()
            .map(|kind| kind.maximum_bytes())
            .max()
            .ok_or(PersistenceError::UnexpectedKind)?;
        let access = if allowed_kinds == [RecordKind::LifecycleSerial] {
            OpenAccess::ReadWriteLock
        } else {
            OpenAccess::ReadOnly { directory: false }
        };
        let descriptor = syscall::open_beneath(parent.as_fd(), name.component(), access)
            .map_err(PersistenceError::Syscall)?;
        let identity = descriptor
            .validate(self.policy(maximum as u64))
            .map_err(PersistenceError::Descriptor)?;
        let bytes = descriptor
            .read_bounded(maximum)
            .map_err(PersistenceError::Descriptor)?;
        let record = AuthenticatedRecord::parse(&bytes, key).map_err(PersistenceError::Record)?;
        if !allowed_kinds.contains(&record.kind) {
            return Err(PersistenceError::UnexpectedKind);
        }
        let identity = strict_identity(identity, record.content_digest)?;
        if let RecordBody::Serial(serial) = record.body
            && (serial.self_identity.device != identity.device
                || serial.self_identity.inode != identity.inode
                || serial.self_identity.uid != identity.uid
                || serial.self_identity.gid != identity.gid
                || serial.self_identity.mode != identity.mode
                || serial.self_identity.link_count != identity.link_count)
        {
            return Err(PersistenceError::IdentityMismatch);
        }
        Ok(HeldRecord {
            descriptor,
            identity,
            record,
        })
    }

    pub fn revalidate(&self, held: &HeldRecord) -> Result<(), PersistenceError> {
        let identity = held
            .descriptor
            .validate(self.policy(held.record.kind.maximum_bytes() as u64))
            .map_err(PersistenceError::Descriptor)?;
        let bytes = held
            .descriptor
            .read_bounded(held.record.kind.maximum_bytes())
            .map_err(PersistenceError::Descriptor)?;
        if crate::sha256::digest(&bytes) != held.record.content_digest
            || strict_identity(identity, held.record.content_digest)? != held.identity
        {
            return Err(PersistenceError::IdentityMismatch);
        }
        Ok(())
    }

    pub fn exchange(
        &self,
        left: RecordEndpoint<'_>,
        right: RecordEndpoint<'_>,
        key: &TokenKey,
    ) -> Result<ExchangeResult, PersistenceError> {
        if !left.name.allows(right.held.record.kind) || !right.name.allows(left.held.record.kind) {
            return Err(PersistenceError::UnexpectedKind);
        }
        self.revalidate(left.held)?;
        self.revalidate(right.held)?;
        let syscall_result = syscall::rename_exchange(
            left.parent.as_fd(),
            left.name.component(),
            right.parent.as_fd(),
            right.name.component(),
        );
        if syscall_result.is_ok() {
            left.parent
                .sync_all()
                .map_err(PersistenceError::MutationAmbiguous)?;
            right
                .parent
                .sync_all()
                .map_err(PersistenceError::MutationAmbiguous)?;
        }
        let allowed = [left.held.record.kind, right.held.record.kind];
        let observed_left = self.observe(left.parent, left.name, &allowed, key);
        let observed_right = self.observe(right.parent, right.name, &allowed, key);
        Ok(classify_exchange(
            syscall_result,
            observed_left,
            observed_right,
            left.held.identity,
            right.held.identity,
        ))
    }

    pub fn publish_noreplace(
        &self,
        source_parent: &Descriptor,
        source_name: RecordName,
        source: &HeldRecord,
        destination_parent: &Descriptor,
        destination_name: RecordName,
        key: &TokenKey,
    ) -> Result<PublicationResult, PersistenceError> {
        if !destination_name.allows(source.record.kind) {
            return Err(PersistenceError::UnexpectedKind);
        }
        self.revalidate(source)?;
        let syscall_result = syscall::rename_noreplace(
            source_parent.as_fd(),
            source_name.component(),
            destination_parent.as_fd(),
            destination_name.component(),
        );
        if syscall_result.is_ok() {
            source_parent
                .sync_all()
                .map_err(PersistenceError::MutationAmbiguous)?;
            destination_parent
                .sync_all()
                .map_err(PersistenceError::MutationAmbiguous)?;
        }
        let allowed = [source.record.kind];
        let source_observation = self.observe(source_parent, source_name, &allowed, key);
        let destination_observation =
            self.observe(destination_parent, destination_name, &allowed, key);
        Ok(classify_noreplace(
            syscall_result,
            source_observation,
            destination_observation,
            source.identity,
        ))
    }

    pub fn load_layout_after_lock(
        &self,
        recovery_root: &Descriptor,
        lock: &SerialLock,
        key: &TokenKey,
    ) -> Result<LayoutSnapshot, PersistenceError> {
        let serial = lock.record();
        if serial.record.kind != RecordKind::LifecycleSerial {
            return Err(PersistenceError::LayoutAmbiguous);
        }
        self.revalidate(serial)
            .map_err(|_| PersistenceError::LayoutAmbiguous)?;
        self.reopen_exact_serial(recovery_root, serial, key)?;
        let root_before = recovery_root
            .validate(self.directory_policy())
            .map_err(PersistenceError::Descriptor)?;
        let RecordBody::Serial(serial_body) = serial.record.body else {
            return Err(PersistenceError::LayoutAmbiguous);
        };
        if serial_body.authority.recovery_root != stable_directory_identity(root_before)? {
            return Err(PersistenceError::LayoutAmbiguous);
        }
        let names_before =
            syscall::list_directory(recovery_root.as_fd(), 7).map_err(PersistenceError::Syscall)?;
        let slots_present = validate_root_names(&names_before)?;

        let lifecycle_current = self.open_allowed(
            recovery_root,
            RecordName::LifecycleCurrent,
            &[RecordKind::LifecycleVacant, RecordKind::LifecycleSelector],
            key,
        )?;
        let restart_current = self.open_allowed(
            recovery_root,
            RecordName::RestartCurrent,
            &[RecordKind::RestartVacant, RecordKind::Journal],
            key,
        )?;
        let launch_current = self.open(
            recovery_root,
            RecordName::LaunchCurrent,
            RecordKind::LaunchVacant,
            key,
        )?;
        for record in [
            &lifecycle_current.record,
            &restart_current.record,
            &launch_current.record,
        ] {
            if !record_binds_serial(record, serial_body.authority, serial.identity) {
                return Err(PersistenceError::LayoutAmbiguous);
            }
        }
        let mut slots = [
            SlotEvidence::Absent,
            SlotEvidence::Absent,
            SlotEvidence::Absent,
        ];
        for (index, present) in slots_present.into_iter().enumerate() {
            if !present {
                continue;
            }
            let terminal = syscall::open_beneath(
                recovery_root.as_fd(),
                TerminalName::from_index(index).component(),
                OpenAccess::ReadOnly { directory: true },
            )
            .map_err(PersistenceError::Syscall)?;
            let terminal_before = terminal
                .validate(self.directory_policy())
                .map_err(PersistenceError::Descriptor)?;
            let terminal_names =
                syscall::list_directory(terminal.as_fd(), 2).map_err(PersistenceError::Syscall)?;
            if terminal_names != [b"journal.exchange".to_vec(), b"lifecycle.exchange".to_vec()] {
                return Err(PersistenceError::LayoutAmbiguous);
            }
            let lifecycle = self.open_allowed(
                &terminal,
                RecordName::LifecycleExchange,
                &[RecordKind::LifecycleVacant, RecordKind::LifecycleSelector],
                key,
            )?;
            let journal = self.open_allowed(
                &terminal,
                RecordName::JournalExchange,
                &[RecordKind::RestartVacant, RecordKind::Journal],
                key,
            )?;
            if !record_binds_serial(&lifecycle.record, serial_body.authority, serial.identity)
                || !record_binds_serial(&journal.record, serial_body.authority, serial.identity)
            {
                return Err(PersistenceError::LayoutAmbiguous);
            }
            validate_loaded_exchange_bindings(
                &lifecycle_current,
                &lifecycle,
                &restart_current,
                &journal,
            )?;
            let terminal_after = terminal
                .validate(self.directory_policy())
                .map_err(PersistenceError::Descriptor)?;
            if terminal_before != terminal_after {
                return Err(PersistenceError::LayoutAmbiguous);
            }
            slots[index] = SlotEvidence::ExchangePair {
                lifecycle: Box::new(lifecycle.record),
                journal: Box::new(journal.record),
            };
        }

        self.revalidate(serial)
            .map_err(|_| PersistenceError::LayoutAmbiguous)?;
        self.reopen_exact_serial(recovery_root, serial, key)?;
        let names_after =
            syscall::list_directory(recovery_root.as_fd(), 7).map_err(PersistenceError::Syscall)?;
        let root_after = recovery_root
            .validate(self.directory_policy())
            .map_err(PersistenceError::Descriptor)?;
        if names_before != names_after || root_before != root_after {
            return Err(PersistenceError::LayoutAmbiguous);
        }
        Ok(LayoutSnapshot {
            lifecycle_current: lifecycle_current.record,
            restart_current: restart_current.record,
            launch_current: launch_current.record,
            slots,
        })
    }

    fn reopen_exact_serial(
        &self,
        recovery_root: &Descriptor,
        locked: &HeldRecord,
        key: &TokenKey,
    ) -> Result<(), PersistenceError> {
        let canonical = self
            .open(
                recovery_root,
                RecordName::LifecycleSerial,
                RecordKind::LifecycleSerial,
                key,
            )
            .map_err(|_| PersistenceError::LayoutAmbiguous)?;
        if canonical.identity != locked.identity
            || canonical.record.content_digest != locked.record.content_digest
            || canonical.record.envelope_digest != locked.record.envelope_digest
            || canonical.record.body != locked.record.body
        {
            return Err(PersistenceError::LayoutAmbiguous);
        }
        Ok(())
    }

    fn observe(
        &self,
        parent: &Descriptor,
        name: RecordName,
        allowed_kinds: &[RecordKind],
        key: &TokenKey,
    ) -> EndpointObservation {
        match self.open_allowed(parent, name, allowed_kinds, key) {
            Ok(held) => EndpointObservation::Exact(held.identity),
            Err(PersistenceError::Syscall(Errno(2))) => EndpointObservation::Absent,
            Err(_) => EndpointObservation::Ambiguous,
        }
    }

    fn policy(self, maximum: u64) -> DescriptorPolicy {
        DescriptorPolicy {
            kind: DescriptorKind::RegularFile,
            owner_uid: self.owner_uid,
            owner_gid: self.owner_gid,
            exact_mode: 0o600,
            require_single_link: true,
            max_size: Some(maximum),
        }
    }

    fn directory_policy(self) -> DescriptorPolicy {
        DescriptorPolicy {
            kind: DescriptorKind::Directory,
            owner_uid: self.owner_uid,
            owner_gid: self.owner_gid,
            exact_mode: 0o700,
            require_single_link: false,
            max_size: None,
        }
    }
}

fn stable_directory_identity(
    identity: DescriptorIdentity,
) -> Result<StableDirectoryIdentity, PersistenceError> {
    let DescriptorIdentity::StableDirectory(common) = identity else {
        return Err(PersistenceError::IdentityMismatch);
    };
    Ok(StableDirectoryIdentity {
        device: common.device,
        inode: common.inode,
        uid: common.uid,
        gid: common.gid,
        mode: common.mode,
    })
}

fn serial_self_identity(
    identity: DescriptorIdentity,
) -> Result<SerialSelfIdentity, PersistenceError> {
    let DescriptorIdentity::StrictLeaf {
        common, link_count, ..
    } = identity
    else {
        return Err(PersistenceError::IdentityMismatch);
    };
    Ok(SerialSelfIdentity {
        device: common.device,
        inode: common.inode,
        uid: common.uid,
        gid: common.gid,
        mode: common.mode,
        link_count,
    })
}

fn serial_record_matches_identity(body: RecordBody, identity: StrictLeafIdentity) -> bool {
    let RecordBody::Serial(serial) = body else {
        return false;
    };
    serial.self_identity
        == SerialSelfIdentity {
            device: identity.device,
            inode: identity.inode,
            uid: identity.uid,
            gid: identity.gid,
            mode: identity.mode,
            link_count: identity.link_count,
        }
}

fn record_binds_serial(
    record: &AuthenticatedRecord,
    authority: crate::record::Authority,
    serial_identity: StrictLeafIdentity,
) -> bool {
    match record.body {
        RecordBody::Serial(serial) => {
            serial.authority == authority
                && serial.self_identity.device == serial_identity.device
                && serial.self_identity.inode == serial_identity.inode
                && serial.self_identity.uid == serial_identity.uid
                && serial.self_identity.gid == serial_identity.gid
                && serial.self_identity.mode == serial_identity.mode
                && serial.self_identity.link_count == serial_identity.link_count
        }
        RecordBody::Vacancy(vacancy) => {
            vacancy.authority == authority && vacancy.serial == serial_identity
        }
        RecordBody::Selector(selector) => selector.serial == serial_identity,
        RecordBody::Journal(journal) => journal.serial == serial_identity,
        // #493 defines codec-only evidence. It is deliberately not admitted
        // into a persistence layout until a later publisher/consumer owns the
        // complete descriptor and process proof.
        RecordBody::ActivePid(_) | RecordBody::ActiveLaunchEvidence(_) => false,
    }
}

fn validate_loaded_exchange_bindings(
    root_lifecycle: &HeldRecord,
    slot_lifecycle: &HeldRecord,
    root_restart: &HeldRecord,
    slot_journal: &HeldRecord,
) -> Result<(), PersistenceError> {
    let (selector, lifecycle_vacancy) =
        match (root_lifecycle.record.body, slot_lifecycle.record.body) {
            (RecordBody::Selector(selector), RecordBody::Vacancy(_)) => {
                (selector, slot_lifecycle.identity)
            }
            (RecordBody::Vacancy(_), RecordBody::Selector(selector)) => {
                (selector, root_lifecycle.identity)
            }
            _ => return Err(PersistenceError::LayoutAmbiguous),
        };
    let (journal, restart_vacancy) = match (root_restart.record.body, slot_journal.record.body) {
        (RecordBody::Journal(journal), RecordBody::Vacancy(_)) => (journal, slot_journal.identity),
        (RecordBody::Vacancy(_), RecordBody::Journal(journal)) => (journal, root_restart.identity),
        _ => return Err(PersistenceError::LayoutAmbiguous),
    };
    if selector.predecessor != lifecycle_vacancy
        || journal.lifecycle_predecessor != lifecycle_vacancy
        || journal.restart_predecessor != restart_vacancy
    {
        return Err(PersistenceError::LayoutAmbiguous);
    }
    Ok(())
}

fn validate_root_names(names: &[Vec<u8>]) -> Result<[bool; 3], PersistenceError> {
    if names.len() < 4 || names.len() > 7 || names.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err(PersistenceError::LayoutAmbiguous);
    }
    let required = [
        b"daemon.launch.current.v1".as_slice(),
        b"lifecycle.current.v1".as_slice(),
        b"lifecycle.serial.v1".as_slice(),
        b"restart.current.v1".as_slice(),
    ];
    if required
        .iter()
        .any(|required_name| !names.iter().any(|name| name == required_name))
    {
        return Err(PersistenceError::LayoutAmbiguous);
    }
    let mut slots = [false; 3];
    for name in names {
        match name.as_slice() {
            b"daemon.launch.current.v1"
            | b"lifecycle.current.v1"
            | b"lifecycle.serial.v1"
            | b"restart.current.v1" => {}
            b"terminal.0.v1" => slots[0] = true,
            b"terminal.1.v1" => slots[1] = true,
            b"terminal.2.v1" => slots[2] = true,
            _ => return Err(PersistenceError::LayoutAmbiguous),
        }
    }
    Ok(slots)
}

fn strict_identity(
    identity: DescriptorIdentity,
    content_digest: [u8; 32],
) -> Result<StrictLeafIdentity, PersistenceError> {
    let DescriptorIdentity::StrictLeaf {
        common,
        link_count,
        size,
    } = identity
    else {
        return Err(PersistenceError::IdentityMismatch);
    };
    Ok(StrictLeafIdentity {
        device: common.device,
        inode: common.inode,
        uid: common.uid,
        gid: common.gid,
        mode: common.mode,
        link_count,
        size,
        content_digest,
    })
}

#[derive(Debug)]
pub struct SerialLock {
    serial: HeldRecord,
}

impl SerialLock {
    pub fn acquire(serial: HeldRecord) -> Result<Self, PersistenceError> {
        syscall::acquire_ofd_lock(serial.descriptor.as_raw_fd())
            .map_err(PersistenceError::Syscall)?;
        Ok(Self { serial })
    }

    pub(crate) fn record(&self) -> &HeldRecord {
        &self.serial
    }
}

impl Drop for SerialLock {
    fn drop(&mut self) {
        let _ = syscall::release_ofd_lock(self.serial.descriptor.as_raw_fd());
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PersistenceError {
    Syscall(Errno),
    Descriptor(DescriptorError),
    Record(RecordError),
    UnexpectedKind,
    IdentityMismatch,
    MutationAmbiguous(DescriptorError),
    LayoutAmbiguous,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExchangeResult {
    Completed,
    NotApplied(Errno),
    Ambiguous,
}

fn classify_exchange(
    syscall_result: Result<(), Errno>,
    observed_left: EndpointObservation,
    observed_right: EndpointObservation,
    original_left: StrictLeafIdentity,
    original_right: StrictLeafIdentity,
) -> ExchangeResult {
    let original = observed_left == EndpointObservation::Exact(original_left)
        && observed_right == EndpointObservation::Exact(original_right);
    let exchanged = observed_left == EndpointObservation::Exact(original_right)
        && observed_right == EndpointObservation::Exact(original_left);
    match (syscall_result, original, exchanged) {
        (Ok(()), false, true) => ExchangeResult::Completed,
        (Err(errno), true, false) => ExchangeResult::NotApplied(errno),
        _ => ExchangeResult::Ambiguous,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PublicationResult {
    Completed,
    NotApplied(Errno),
    Ambiguous,
}

fn classify_noreplace(
    syscall_result: Result<(), Errno>,
    source: EndpointObservation,
    destination: EndpointObservation,
    expected: StrictLeafIdentity,
) -> PublicationResult {
    match (syscall_result, source, destination) {
        (Ok(()), EndpointObservation::Absent, EndpointObservation::Exact(identity))
            if identity == expected =>
        {
            PublicationResult::Completed
        }
        (Err(errno), EndpointObservation::Exact(identity), EndpointObservation::Absent)
            if identity == expected =>
        {
            PublicationResult::NotApplied(errno)
        }
        _ => PublicationResult::Ambiguous,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum EndpointObservation {
    Absent,
    Exact(StrictLeafIdentity),
    Ambiguous,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SlotEvidence {
    Absent,
    ExchangePair {
        lifecycle: Box<AuthenticatedRecord>,
        journal: Box<AuthenticatedRecord>,
    },
    Unsupported,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LayoutSnapshot {
    pub lifecycle_current: AuthenticatedRecord,
    pub restart_current: AuthenticatedRecord,
    pub launch_current: AuthenticatedRecord,
    pub slots: [SlotEvidence; 3],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LayoutState {
    StableEmpty,
    Unresolved {
        operation_id: [u8; 32],
        terminal_slot: u8,
    },
    ActivePrepared {
        operation_id: [u8; 32],
        terminal_slot: u8,
    },
    Ambiguous,
}

pub fn classify_layout(snapshot: &LayoutSnapshot) -> LayoutState {
    if snapshot.launch_current.kind != RecordKind::LaunchVacant {
        return LayoutState::Ambiguous;
    }
    let occupied: Vec<(usize, &AuthenticatedRecord, &AuthenticatedRecord)> = snapshot
        .slots
        .iter()
        .enumerate()
        .filter_map(|(index, slot)| match slot {
            SlotEvidence::ExchangePair { lifecycle, journal } => {
                Some((index, lifecycle.as_ref(), journal.as_ref()))
            }
            SlotEvidence::Absent => None,
            SlotEvidence::Unsupported => {
                Some((index, &snapshot.launch_current, &snapshot.launch_current))
            }
        })
        .collect();
    if occupied.is_empty() {
        return if snapshot.lifecycle_current.kind == RecordKind::LifecycleVacant
            && snapshot.restart_current.kind == RecordKind::RestartVacant
            && snapshot
                .slots
                .iter()
                .all(|slot| matches!(slot, SlotEvidence::Absent))
        {
            LayoutState::StableEmpty
        } else {
            LayoutState::Ambiguous
        };
    }
    if occupied.len() != 1
        || snapshot
            .slots
            .iter()
            .any(|slot| matches!(slot, SlotEvidence::Unsupported))
    {
        return LayoutState::Ambiguous;
    }
    let (slot_index, slot_lifecycle, slot_journal) = occupied[0];
    let Some(selector) = exactly_one_selector(&snapshot.lifecycle_current, slot_lifecycle) else {
        return LayoutState::Ambiguous;
    };
    let Some(journal) = exactly_one_journal(&snapshot.restart_current, slot_journal) else {
        return LayoutState::Ambiguous;
    };
    if selector.operation_id != journal.operation_id
        || selector.operation_kind != journal.operation_kind
        || selector.terminal_slot != journal.terminal_slot
        || selector.terminal_slot as usize != slot_index
        || selector.serial != journal.serial
        || selector.predecessor != journal.lifecycle_predecessor
        || selector.token != journal.token
        || selector.preflight_digest != journal.preflight_digest
        || selector.expected_pid_digest != journal.expected_pid_digest
        || selector.expected_launch_digest != journal.expected_launch_digest
    {
        return LayoutState::Ambiguous;
    }
    let lifecycle_pair_valid = pair_has_kinds(
        &snapshot.lifecycle_current,
        slot_lifecycle,
        RecordKind::LifecycleVacant,
        RecordKind::LifecycleSelector,
    );
    let journal_pair_valid = pair_has_kinds(
        &snapshot.restart_current,
        slot_journal,
        RecordKind::RestartVacant,
        RecordKind::Journal,
    );
    if !lifecycle_pair_valid || !journal_pair_valid {
        return LayoutState::Ambiguous;
    }
    let active = snapshot.lifecycle_current.kind == RecordKind::LifecycleSelector
        && snapshot.restart_current.kind == RecordKind::Journal;
    if active {
        LayoutState::ActivePrepared {
            operation_id: selector.operation_id,
            terminal_slot: selector.terminal_slot,
        }
    } else {
        LayoutState::Unresolved {
            operation_id: selector.operation_id,
            terminal_slot: selector.terminal_slot,
        }
    }
}

fn exactly_one_selector<'a>(
    left: &'a AuthenticatedRecord,
    right: &'a AuthenticatedRecord,
) -> Option<SelectorRecord> {
    match (left.body, right.body) {
        (RecordBody::Selector(selector), RecordBody::Vacancy(_))
        | (RecordBody::Vacancy(_), RecordBody::Selector(selector)) => Some(selector),
        _ => None,
    }
}

fn exactly_one_journal(
    left: &AuthenticatedRecord,
    right: &AuthenticatedRecord,
) -> Option<JournalRecord> {
    match (left.body, right.body) {
        (RecordBody::Journal(journal), RecordBody::Vacancy(_))
        | (RecordBody::Vacancy(_), RecordBody::Journal(journal)) => Some(journal),
        _ => None,
    }
}

fn pair_has_kinds(
    left: &AuthenticatedRecord,
    right: &AuthenticatedRecord,
    first: RecordKind,
    second: RecordKind,
) -> bool {
    (left.kind == first && right.kind == second) || (left.kind == second && right.kind == first)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CreateEvidence {
    pub name_present: bool,
    pub exact_content: bool,
    pub file_synced: bool,
    pub parent_synced: bool,
    pub reopened_and_identical: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CreateState {
    Absent,
    Durable,
    Unresolved,
}

pub fn classify_create(evidence: CreateEvidence) -> CreateState {
    if !evidence.name_present
        && !evidence.exact_content
        && !evidence.file_synced
        && !evidence.parent_synced
        && !evidence.reopened_and_identical
    {
        CreateState::Absent
    } else if evidence.name_present
        && evidence.exact_content
        && evidence.file_synced
        && evidence.parent_synced
        && evidence.reopened_and_identical
    {
        CreateState::Durable
    } else {
        CreateState::Unresolved
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record::{
        ActiveLaunchEvidenceRecord, ActivePidRecord, Authority, OperationKind,
        StableDirectoryIdentity, VacancyRecord,
    };
    use std::fs::{self, File, OpenOptions};
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn create() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "lcm-helper-persistence-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir(&path).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    fn key() -> TokenKey {
        TokenKey::parse(&[b'a'; 64]).unwrap()
    }

    fn strict(seed: u8) -> StrictLeafIdentity {
        StrictLeafIdentity {
            device: seed as u64,
            inode: seed as u64 + 1,
            uid: 1000,
            gid: 1000,
            mode: 0o600,
            link_count: 1,
            size: 100,
            content_digest: [seed; 32],
        }
    }

    fn authority() -> Authority {
        Authority {
            state_root: StableDirectoryIdentity {
                device: 1,
                inode: 2,
                uid: 1000,
                gid: 1000,
                mode: 0o700,
            },
            recovery_root: StableDirectoryIdentity {
                device: 1,
                inode: 3,
                uid: 1000,
                gid: 1000,
                mode: 0o700,
            },
            helper_digest: [4; 32],
        }
    }

    fn vacancy(kind: RecordKind, seed: u8) -> AuthenticatedRecord {
        AuthenticatedRecord::encode(
            kind,
            RecordBody::Vacancy(VacancyRecord {
                authority: authority(),
                serial: strict(seed),
            }),
            &key(),
        )
        .unwrap()
    }

    fn active_pid_record() -> AuthenticatedRecord {
        AuthenticatedRecord::encode(
            RecordKind::ActivePid,
            RecordBody::ActivePid(ActivePidRecord {
                authority: authority(),
                serial: strict(10),
                token: strict(20),
                configuration: strict(30),
                runtime: strict(40),
                listener_digest: [50; 32],
                admitted_facts_digest: [60; 32],
                pid: 1234,
                process_start_time: 5678,
                process_digest: [70; 32],
            }),
            &key(),
        )
        .unwrap()
    }

    fn launch_record(active_pid_digest: [u8; 32]) -> AuthenticatedRecord {
        AuthenticatedRecord::encode(
            RecordKind::ActiveLaunchEvidence,
            RecordBody::ActiveLaunchEvidence(ActiveLaunchEvidenceRecord {
                authority: authority(),
                serial: strict(10),
                token: strict(20),
                configuration: strict(30),
                runtime: strict(40),
                listener_digest: [50; 32],
                admitted_facts_digest: [60; 32],
                active_pid_digest,
            }),
            &key(),
        )
        .unwrap()
    }

    fn held_raw(
        path: &std::path::Path,
        record: AuthenticatedRecord,
        store: RecordStore,
    ) -> HeldRecord {
        fs::write(path, record.canonical_bytes()).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
        let descriptor = Descriptor::from_file(
            OpenOptions::new()
                .read(true)
                .write(true)
                .open(path)
                .unwrap(),
        );
        let identity = descriptor
            .validate(store.policy(record.kind.maximum_bytes() as u64))
            .unwrap();
        HeldRecord {
            descriptor,
            identity: strict_identity(identity, record.content_digest).unwrap(),
            record,
        }
    }

    #[test]
    fn legacy_bounded_reads_reject_513_bytes_while_evidence_cap_accepts_exact_records() {
        let temporary = TestDirectory::create();
        let metadata = fs::metadata(&temporary.0).unwrap();
        let root = Descriptor::from_file(File::open(&temporary.0).unwrap());
        let store = RecordStore::new(metadata.uid(), metadata.gid());
        let token = key();

        fs::write(temporary.0.join("lifecycle.current.v1"), [0_u8; 513]).unwrap();
        fs::set_permissions(
            temporary.0.join("lifecycle.current.v1"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        assert!(matches!(
            store.open(
                &root,
                RecordName::LifecycleCurrent,
                RecordKind::LifecycleVacant,
                &token,
            ),
            Err(PersistenceError::Descriptor(DescriptorError::TooLarge))
        ));

        let evidence = active_pid_record();
        assert_eq!(
            evidence.canonical_bytes().len(),
            RecordKind::ActivePid.maximum_bytes()
        );
        let descriptor = Descriptor::from_file(
            OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .open(temporary.0.join("active-evidence"))
                .unwrap(),
        );
        descriptor
            .write_complete_at_start(evidence.canonical_bytes())
            .unwrap();
        assert_eq!(
            descriptor
                .read_bounded(RecordKind::ActivePid.maximum_bytes())
                .unwrap(),
            evidence.canonical_bytes()
        );
    }

    fn selector(slot: u8, operation: u8) -> AuthenticatedRecord {
        AuthenticatedRecord::encode(
            RecordKind::LifecycleSelector,
            RecordBody::Selector(SelectorRecord {
                operation_id: [operation; 32],
                operation_kind: OperationKind::InitialStart,
                terminal_slot: slot,
                phase_bitmap: 1,
                serial: strict(10),
                predecessor: strict(11),
                token: strict(12),
                preflight_digest: [13; 32],
                expected_pid_digest: [14; 32],
                expected_launch_digest: [15; 32],
            }),
            &key(),
        )
        .unwrap()
    }

    fn journal(slot: u8, operation: u8) -> AuthenticatedRecord {
        AuthenticatedRecord::encode(
            RecordKind::Journal,
            RecordBody::Journal(JournalRecord {
                operation_id: [operation; 32],
                operation_kind: OperationKind::InitialStart,
                terminal_slot: slot,
                phase_bitmap: 1,
                serial: strict(10),
                lifecycle_predecessor: strict(11),
                restart_predecessor: strict(17),
                token: strict(12),
                preflight_digest: [13; 32],
                expected_pid_digest: [14; 32],
                expected_launch_digest: [15; 32],
            }),
            &key(),
        )
        .unwrap()
    }

    fn stable_snapshot() -> LayoutSnapshot {
        LayoutSnapshot {
            lifecycle_current: vacancy(RecordKind::LifecycleVacant, 20),
            restart_current: vacancy(RecordKind::RestartVacant, 21),
            launch_current: vacancy(RecordKind::LaunchVacant, 22),
            slots: [
                SlotEvidence::Absent,
                SlotEvidence::Absent,
                SlotEvidence::Absent,
            ],
        }
    }

    #[test]
    fn stable_layout_requires_exact_vacancies_and_no_slots() {
        let stable = stable_snapshot();
        assert_eq!(classify_layout(&stable), LayoutState::StableEmpty);
        let mut wrong = stable;
        wrong.launch_current = selector(0, 9);
        assert_eq!(classify_layout(&wrong), LayoutState::Ambiguous);
    }

    #[test]
    fn root_name_parser_rejects_unknown_missing_and_duplicate_entries() {
        let exact = vec![
            b"daemon.launch.current.v1".to_vec(),
            b"lifecycle.current.v1".to_vec(),
            b"lifecycle.serial.v1".to_vec(),
            b"restart.current.v1".to_vec(),
        ];
        assert_eq!(validate_root_names(&exact), Ok([false; 3]));
        let mut unknown = exact.clone();
        unknown.push(b"surprise".to_vec());
        assert_eq!(
            validate_root_names(&unknown),
            Err(PersistenceError::LayoutAmbiguous)
        );
        assert_eq!(
            validate_root_names(&exact[..3]),
            Err(PersistenceError::LayoutAmbiguous)
        );
        let mut duplicate = exact;
        duplicate.insert(1, b"lifecycle.current.v1".to_vec());
        duplicate.sort();
        assert_eq!(
            validate_root_names(&duplicate),
            Err(PersistenceError::LayoutAmbiguous)
        );
    }

    #[test]
    fn every_prepare_crash_boundary_retains_one_unresolved_operation() {
        let lifecycle_vacancy = vacancy(RecordKind::LifecycleVacant, 20);
        let restart_vacancy = vacancy(RecordKind::RestartVacant, 21);
        let lifecycle = selector(0, 9);
        let restart = journal(0, 9);

        let snapshots = [
            LayoutSnapshot {
                lifecycle_current: lifecycle_vacancy.clone(),
                restart_current: restart_vacancy.clone(),
                launch_current: vacancy(RecordKind::LaunchVacant, 22),
                slots: [
                    SlotEvidence::ExchangePair {
                        lifecycle: Box::new(lifecycle.clone()),
                        journal: Box::new(restart.clone()),
                    },
                    SlotEvidence::Absent,
                    SlotEvidence::Absent,
                ],
            },
            LayoutSnapshot {
                lifecycle_current: lifecycle.clone(),
                restart_current: restart_vacancy.clone(),
                launch_current: vacancy(RecordKind::LaunchVacant, 22),
                slots: [
                    SlotEvidence::ExchangePair {
                        lifecycle: Box::new(lifecycle_vacancy.clone()),
                        journal: Box::new(restart.clone()),
                    },
                    SlotEvidence::Absent,
                    SlotEvidence::Absent,
                ],
            },
        ];
        for snapshot in snapshots {
            assert_eq!(
                classify_layout(&snapshot),
                LayoutState::Unresolved {
                    operation_id: [9; 32],
                    terminal_slot: 0,
                }
            );
        }

        let active = LayoutSnapshot {
            lifecycle_current: lifecycle,
            restart_current: restart,
            launch_current: vacancy(RecordKind::LaunchVacant, 22),
            slots: [
                SlotEvidence::ExchangePair {
                    lifecycle: Box::new(lifecycle_vacancy),
                    journal: Box::new(restart_vacancy),
                },
                SlotEvidence::Absent,
                SlotEvidence::Absent,
            ],
        };
        assert_eq!(
            classify_layout(&active),
            LayoutState::ActivePrepared {
                operation_id: [9; 32],
                terminal_slot: 0,
            }
        );
    }

    #[test]
    fn second_or_conflicting_journal_is_ambiguous() {
        let mut snapshot = stable_snapshot();
        snapshot.slots = [
            SlotEvidence::ExchangePair {
                lifecycle: Box::new(selector(0, 9)),
                journal: Box::new(journal(0, 9)),
            },
            SlotEvidence::ExchangePair {
                lifecycle: Box::new(selector(1, 10)),
                journal: Box::new(journal(1, 10)),
            },
            SlotEvidence::Absent,
        ];
        assert_eq!(classify_layout(&snapshot), LayoutState::Ambiguous);

        let mut mismatch = stable_snapshot();
        mismatch.slots[0] = SlotEvidence::ExchangePair {
            lifecycle: Box::new(selector(0, 9)),
            journal: Box::new(journal(0, 10)),
        };
        assert_eq!(classify_layout(&mismatch), LayoutState::Ambiguous);
    }

    #[test]
    fn publication_classifiers_never_guess_after_faults() {
        let left = strict(1);
        let right = strict(2);
        assert_eq!(
            classify_exchange(
                Ok(()),
                EndpointObservation::Exact(right),
                EndpointObservation::Exact(left),
                left,
                right,
            ),
            ExchangeResult::Completed
        );
        assert_eq!(
            classify_exchange(
                Err(Errno(5)),
                EndpointObservation::Exact(left),
                EndpointObservation::Exact(right),
                left,
                right,
            ),
            ExchangeResult::NotApplied(Errno(5))
        );
        assert_eq!(
            classify_exchange(
                Err(Errno(5)),
                EndpointObservation::Exact(right),
                EndpointObservation::Exact(left),
                left,
                right,
            ),
            ExchangeResult::Ambiguous
        );
        assert_eq!(
            classify_noreplace(
                Ok(()),
                EndpointObservation::Absent,
                EndpointObservation::Exact(left),
                left,
            ),
            PublicationResult::Completed
        );
        assert_eq!(
            classify_noreplace(
                Err(Errno(5)),
                EndpointObservation::Ambiguous,
                EndpointObservation::Exact(left),
                left,
            ),
            PublicationResult::Ambiguous
        );
    }

    #[test]
    fn failed_noreplace_with_replaced_source_is_ambiguous() {
        let expected = strict(1);
        let mut replacement = strict(9);
        replacement.content_digest = expected.content_digest;
        assert_ne!(replacement, expected);
        assert_eq!(
            classify_noreplace(
                Err(Errno(5)),
                EndpointObservation::Exact(replacement),
                EndpointObservation::Absent,
                expected,
            ),
            PublicationResult::Ambiguous
        );
        assert_eq!(
            classify_noreplace(
                Err(Errno(5)),
                EndpointObservation::Exact(expected),
                EndpointObservation::Absent,
                expected,
            ),
            PublicationResult::NotApplied(Errno(5))
        );
    }

    #[test]
    fn every_partial_create_is_unresolved() {
        let fields = [
            CreateEvidence {
                name_present: true,
                exact_content: false,
                file_synced: false,
                parent_synced: false,
                reopened_and_identical: false,
            },
            CreateEvidence {
                name_present: true,
                exact_content: true,
                file_synced: false,
                parent_synced: false,
                reopened_and_identical: false,
            },
            CreateEvidence {
                name_present: true,
                exact_content: true,
                file_synced: true,
                parent_synced: false,
                reopened_and_identical: false,
            },
            CreateEvidence {
                name_present: true,
                exact_content: true,
                file_synced: true,
                parent_synced: true,
                reopened_and_identical: false,
            },
        ];
        for evidence in fields {
            assert_eq!(classify_create(evidence), CreateState::Unresolved);
        }
        assert_eq!(
            classify_create(CreateEvidence {
                name_present: true,
                exact_content: true,
                file_synced: true,
                parent_synced: true,
                reopened_and_identical: true,
            }),
            CreateState::Durable
        );
    }

    #[test]
    fn descriptor_owned_create_reopen_and_exchange_are_identity_checked() {
        let temporary = TestDirectory::create();
        let slot_path = temporary.0.join("terminal.0.v1");
        fs::create_dir(&slot_path).unwrap();
        fs::set_permissions(&slot_path, fs::Permissions::from_mode(0o700)).unwrap();
        let metadata = fs::metadata(&temporary.0).unwrap();
        let store = RecordStore::new(metadata.uid(), metadata.gid());
        let root = Descriptor::from_file(File::open(&temporary.0).unwrap());
        let slot = Descriptor::from_file(File::open(&slot_path).unwrap());
        let token = key();

        let vacancy_record = vacancy(RecordKind::LifecycleVacant, 20);
        let held_vacancy = store
            .create_exclusive(
                &root,
                RecordName::LifecycleCurrent,
                vacancy_record.clone(),
                &token,
            )
            .unwrap();
        let selector_record = selector(0, 9);
        let held_selector = store
            .create_exclusive(
                &slot,
                RecordName::LifecycleExchange,
                selector_record.clone(),
                &token,
            )
            .unwrap();
        assert_eq!(
            store
                .exchange(
                    RecordEndpoint {
                        parent: &root,
                        name: RecordName::LifecycleCurrent,
                        held: &held_vacancy,
                    },
                    RecordEndpoint {
                        parent: &slot,
                        name: RecordName::LifecycleExchange,
                        held: &held_selector,
                    },
                    &token,
                )
                .unwrap(),
            ExchangeResult::Completed
        );
        assert_eq!(
            store
                .open(
                    &root,
                    RecordName::LifecycleCurrent,
                    RecordKind::LifecycleSelector,
                    &token,
                )
                .unwrap()
                .record
                .content_digest,
            selector_record.content_digest
        );
        assert_eq!(
            store
                .open(
                    &slot,
                    RecordName::LifecycleExchange,
                    RecordKind::LifecycleVacant,
                    &token,
                )
                .unwrap()
                .record
                .content_digest,
            vacancy_record.content_digest
        );
    }

    #[test]
    fn descriptor_owned_loader_accepts_only_the_exact_locked_stable_layout() {
        let temporary = TestDirectory::create();
        let root_metadata = fs::metadata(&temporary.0).unwrap();
        let root_identity = StableDirectoryIdentity {
            device: root_metadata.dev(),
            inode: root_metadata.ino(),
            uid: root_metadata.uid(),
            gid: root_metadata.gid(),
            mode: root_metadata.mode() & 0o7777,
        };
        let authority = Authority {
            state_root: StableDirectoryIdentity {
                inode: root_identity.inode + 1,
                ..root_identity
            },
            recovery_root: root_identity,
            helper_digest: [4; 32],
        };
        let root = Descriptor::from_file(File::open(&temporary.0).unwrap());
        let store = RecordStore::new(root_metadata.uid(), root_metadata.gid());
        let token = key();
        let serial = store
            .create_serial_exclusive(&root, authority, &token)
            .unwrap();
        let vacancy_body = |kind| {
            AuthenticatedRecord::encode(
                kind,
                RecordBody::Vacancy(VacancyRecord {
                    authority,
                    serial: serial.identity,
                }),
                &token,
            )
            .unwrap()
        };
        store
            .create_exclusive(
                &root,
                RecordName::LifecycleCurrent,
                vacancy_body(RecordKind::LifecycleVacant),
                &token,
            )
            .unwrap();
        store
            .create_exclusive(
                &root,
                RecordName::RestartCurrent,
                vacancy_body(RecordKind::RestartVacant),
                &token,
            )
            .unwrap();
        store
            .create_exclusive(
                &root,
                RecordName::LaunchCurrent,
                vacancy_body(RecordKind::LaunchVacant),
                &token,
            )
            .unwrap();
        let lock = SerialLock::acquire(serial).unwrap();
        let snapshot = store.load_layout_after_lock(&root, &lock, &token).unwrap();
        assert_eq!(classify_layout(&snapshot), LayoutState::StableEmpty);

        fs::write(temporary.0.join("unknown"), b"").unwrap();
        assert_eq!(
            store.load_layout_after_lock(&root, &lock, &token),
            Err(PersistenceError::LayoutAmbiguous)
        );
        fs::remove_file(temporary.0.join("unknown")).unwrap();

        let replacement_directory = TestDirectory::create();
        let replacement_root = Descriptor::from_file(File::open(&replacement_directory.0).unwrap());
        let replacement_metadata = fs::metadata(&replacement_directory.0).unwrap();
        let replacement_store =
            RecordStore::new(replacement_metadata.uid(), replacement_metadata.gid());
        replacement_store
            .create_serial_exclusive(&replacement_root, authority, &token)
            .unwrap();
        fs::rename(
            replacement_directory.0.join("lifecycle.serial.v1"),
            temporary.0.join("lifecycle.serial.v1"),
        )
        .unwrap();
        assert_eq!(
            store.load_layout_after_lock(&root, &lock, &token),
            Err(PersistenceError::LayoutAmbiguous)
        );
    }

    #[test]
    fn valid_signed_active_evidence_cannot_enter_authoritative_names_or_layout() {
        let temporary = TestDirectory::create();
        let root_metadata = fs::metadata(&temporary.0).unwrap();
        let root_identity = StableDirectoryIdentity {
            device: root_metadata.dev(),
            inode: root_metadata.ino(),
            uid: root_metadata.uid(),
            gid: root_metadata.gid(),
            mode: root_metadata.mode() & 0o7777,
        };
        let authority = Authority {
            state_root: StableDirectoryIdentity {
                inode: root_identity.inode + 1,
                ..root_identity
            },
            recovery_root: root_identity,
            helper_digest: [4; 32],
        };
        let root = Descriptor::from_file(File::open(&temporary.0).unwrap());
        let store = RecordStore::new(root_metadata.uid(), root_metadata.gid());
        let token = key();
        let serial = store
            .create_serial_exclusive(&root, authority, &token)
            .unwrap();
        for (name, kind) in [
            (RecordName::LifecycleCurrent, RecordKind::LifecycleVacant),
            (RecordName::RestartCurrent, RecordKind::RestartVacant),
            (RecordName::LaunchCurrent, RecordKind::LaunchVacant),
        ] {
            store
                .create_exclusive(
                    &root,
                    name,
                    AuthenticatedRecord::encode(
                        kind,
                        RecordBody::Vacancy(VacancyRecord {
                            authority,
                            serial: serial.identity,
                        }),
                        &token,
                    )
                    .unwrap(),
                    &token,
                )
                .unwrap();
        }
        let lock = SerialLock::acquire(serial).unwrap();
        assert_eq!(
            classify_layout(&store.load_layout_after_lock(&root, &lock, &token).unwrap()),
            LayoutState::StableEmpty
        );

        let active = active_pid_record();
        let launch = launch_record(active.content_digest);
        assert!(matches!(
            store.create_exclusive(&root, RecordName::DaemonPid, active.clone(), &token),
            Err(PersistenceError::UnexpectedKind)
        ));
        assert!(!temporary.0.join("daemon.pid").exists());
        assert!(matches!(
            store.create_exclusive(&root, RecordName::LaunchCurrent, launch.clone(), &token),
            Err(PersistenceError::UnexpectedKind)
        ));

        let held_active = held_raw(&temporary.0.join("journal.exchange"), active.clone(), store);
        assert_eq!(
            store.publish_noreplace(
                &root,
                RecordName::JournalExchange,
                &held_active,
                &root,
                RecordName::DaemonPid,
                &token,
            ),
            Err(PersistenceError::UnexpectedKind)
        );
        let held_launch = held_raw(
            &temporary.0.join("lifecycle.exchange"),
            launch.clone(),
            store,
        );
        assert_eq!(
            store.exchange(
                RecordEndpoint {
                    parent: &root,
                    name: RecordName::JournalExchange,
                    held: &held_active,
                },
                RecordEndpoint {
                    parent: &root,
                    name: RecordName::LifecycleExchange,
                    held: &held_launch,
                },
                &token,
            ),
            Err(PersistenceError::UnexpectedKind)
        );
        drop(held_active);
        drop(held_launch);
        fs::remove_file(temporary.0.join("journal.exchange")).unwrap();
        fs::remove_file(temporary.0.join("lifecycle.exchange")).unwrap();

        fs::write(temporary.0.join("evidence.pid"), active.canonical_bytes()).unwrap();
        fs::set_permissions(
            temporary.0.join("evidence.pid"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        fs::rename(
            temporary.0.join("evidence.pid"),
            temporary.0.join("daemon.pid"),
        )
        .unwrap();
        assert!(matches!(
            store.open(&root, RecordName::DaemonPid, RecordKind::PidVacant, &token),
            Err(PersistenceError::UnexpectedKind)
        ));
        assert_eq!(
            store.load_layout_after_lock(&root, &lock, &token),
            Err(PersistenceError::LayoutAmbiguous)
        );
        fs::remove_file(temporary.0.join("daemon.pid")).unwrap();

        fs::write(
            temporary.0.join("evidence.launch"),
            launch.canonical_bytes(),
        )
        .unwrap();
        fs::set_permissions(
            temporary.0.join("evidence.launch"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        syscall::rename_exchange(
            root.as_fd(),
            c"daemon.launch.current.v1",
            root.as_fd(),
            c"evidence.launch",
        )
        .unwrap();
        assert!(matches!(
            store.open(
                &root,
                RecordName::LaunchCurrent,
                RecordKind::LaunchVacant,
                &token
            ),
            Err(PersistenceError::Descriptor(DescriptorError::TooLarge))
        ));
        assert_eq!(
            store.load_layout_after_lock(&root, &lock, &token),
            Err(PersistenceError::LayoutAmbiguous)
        );
        syscall::rename_exchange(
            root.as_fd(),
            c"daemon.launch.current.v1",
            root.as_fd(),
            c"evidence.launch",
        )
        .unwrap();
        fs::remove_file(temporary.0.join("evidence.launch")).unwrap();
        assert_eq!(
            classify_layout(&store.load_layout_after_lock(&root, &lock, &token).unwrap()),
            LayoutState::StableEmpty
        );
    }

    #[test]
    fn descriptor_owned_noreplace_requires_absent_destination() {
        let temporary = TestDirectory::create();
        let slot_path = temporary.0.join("terminal.0.v1");
        fs::create_dir(&slot_path).unwrap();
        fs::set_permissions(&slot_path, fs::Permissions::from_mode(0o700)).unwrap();
        let metadata = fs::metadata(&temporary.0).unwrap();
        let store = RecordStore::new(metadata.uid(), metadata.gid());
        let root = Descriptor::from_file(File::open(&temporary.0).unwrap());
        let slot = Descriptor::from_file(File::open(&slot_path).unwrap());
        let token = key();
        let record = vacancy(RecordKind::RestartVacant, 21);
        let held = store
            .create_exclusive(&slot, RecordName::JournalExchange, record.clone(), &token)
            .unwrap();
        assert_eq!(
            store
                .publish_noreplace(
                    &slot,
                    RecordName::JournalExchange,
                    &held,
                    &root,
                    RecordName::RestartCurrent,
                    &token,
                )
                .unwrap(),
            PublicationResult::Completed
        );
        assert_eq!(
            store
                .open(
                    &root,
                    RecordName::RestartCurrent,
                    RecordKind::RestartVacant,
                    &token,
                )
                .unwrap()
                .record
                .content_digest,
            record.content_digest
        );
    }

    #[test]
    fn real_ofd_lock_refuses_a_second_open_file_description() {
        let temporary = TestDirectory::create();
        let path = temporary.0.join("serial");
        OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        let first = Descriptor::from_file(
            OpenOptions::new()
                .read(true)
                .write(true)
                .open(&path)
                .unwrap(),
        );
        let second = Descriptor::from_file(
            OpenOptions::new()
                .read(true)
                .write(true)
                .open(&path)
                .unwrap(),
        );
        syscall::acquire_ofd_lock(first.as_raw_fd()).unwrap();
        assert!(matches!(
            syscall::acquire_ofd_lock(second.as_raw_fd()),
            Err(Errno(11) | Errno(13))
        ));
        syscall::release_ofd_lock(first.as_raw_fd()).unwrap();
        assert!(syscall::acquire_ofd_lock(second.as_raw_fd()).is_ok());
    }
}
