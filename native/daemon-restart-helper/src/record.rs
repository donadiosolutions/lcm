//! Canonical authenticated durable-control records.

use crate::sha256;
use core::fmt;

const MAGIC: [u8; 4] = *b"LCMR";
const VERSION: u16 = 1;
const HEADER_LEN: usize = 12;
const DIGEST_LEN: usize = 32;
const MAC_LEN: usize = 32;
const MAC_DOMAIN: &[u8] = b"LCMR/PERSIST/v1";
const KNOWN_PHASE_MASK: u64 = (1_u64 << 15) - 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u16)]
pub enum RecordKind {
    LifecycleSerial = 0x0001,
    LifecycleVacant = 0x0002,
    RestartVacant = 0x0003,
    LaunchVacant = 0x0004,
    PidVacant = 0x0005,
    ActivePid = 0x0006,
    Launch = 0x0007,
    LifecycleSelector = 0x0010,
    Journal = 0x0011,
}

impl RecordKind {
    pub fn from_u16(value: u16) -> Option<Self> {
        Some(match value {
            0x0001 => Self::LifecycleSerial,
            0x0002 => Self::LifecycleVacant,
            0x0003 => Self::RestartVacant,
            0x0004 => Self::LaunchVacant,
            0x0005 => Self::PidVacant,
            0x0006 => Self::ActivePid,
            0x0007 => Self::Launch,
            0x0010 => Self::LifecycleSelector,
            0x0011 => Self::Journal,
            _ => return None,
        })
    }

    pub const fn maximum_bytes(self) -> usize {
        match self {
            Self::LifecycleSerial
            | Self::LifecycleVacant
            | Self::RestartVacant
            | Self::LaunchVacant
            | Self::PidVacant
            | Self::ActivePid
            | Self::Launch => 1024,
            Self::LifecycleSelector | Self::Journal => 16 * 1024,
        }
    }
}

pub struct TokenKey([u8; 64]);

impl TokenKey {
    pub fn parse(bytes: &[u8]) -> Result<Self, RecordError> {
        if bytes.len() != 64
            || bytes
                .iter()
                .any(|byte| !matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        {
            return Err(RecordError::InvalidToken);
        }
        Ok(Self(bytes.try_into().expect("exact token length")))
    }

    fn bytes(&self) -> &[u8; 64] {
        &self.0
    }
}

impl fmt::Debug for TokenKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TokenKey([REDACTED])")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StableDirectoryIdentity {
    pub device: u64,
    pub inode: u64,
    pub uid: u32,
    pub gid: u32,
    pub mode: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StrictLeafIdentity {
    pub device: u64,
    pub inode: u64,
    pub uid: u32,
    pub gid: u32,
    pub mode: u32,
    pub link_count: u64,
    pub size: u64,
    pub content_digest: [u8; 32],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SerialSelfIdentity {
    pub device: u64,
    pub inode: u64,
    pub uid: u32,
    pub gid: u32,
    pub mode: u32,
    pub link_count: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Authority {
    pub state_root: StableDirectoryIdentity,
    pub recovery_root: StableDirectoryIdentity,
    pub helper_digest: [u8; 32],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SerialRecord {
    pub authority: Authority,
    pub self_identity: SerialSelfIdentity,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VacancyRecord {
    pub authority: Authority,
    pub serial: StrictLeafIdentity,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum OperationKind {
    InitialStart = 1,
    Rotation = 2,
    Recovery = 3,
    RetireDead = 4,
}

impl OperationKind {
    fn from_u8(value: u8) -> Option<Self> {
        Some(match value {
            1 => Self::InitialStart,
            2 => Self::Rotation,
            3 => Self::Recovery,
            4 => Self::RetireDead,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SelectorRecord {
    pub operation_id: [u8; 32],
    pub operation_kind: OperationKind,
    pub terminal_slot: u8,
    pub phase_bitmap: u64,
    pub serial: StrictLeafIdentity,
    pub predecessor: StrictLeafIdentity,
    pub token: StrictLeafIdentity,
    pub preflight_digest: [u8; 32],
    pub expected_pid_digest: [u8; 32],
    pub expected_launch_digest: [u8; 32],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct JournalRecord {
    pub operation_id: [u8; 32],
    pub operation_kind: OperationKind,
    pub terminal_slot: u8,
    pub phase_bitmap: u64,
    pub serial: StrictLeafIdentity,
    pub lifecycle_predecessor: StrictLeafIdentity,
    pub restart_predecessor: StrictLeafIdentity,
    pub token: StrictLeafIdentity,
    pub preflight_digest: [u8; 32],
    pub expected_pid_digest: [u8; 32],
    pub expected_launch_digest: [u8; 32],
}

/// Authenticated facts for the exact active PID published by a future managed
/// launch implementation. This pure schema is deliberately not publication or
/// recovery authority: its consumer must independently hold and revalidate all
/// descriptor, process, and admission evidence described in the protocol.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ActivePidRecord {
    pub authority: Authority,
    pub serial: StrictLeafIdentity,
    pub token: StrictLeafIdentity,
    pub configuration: StrictLeafIdentity,
    pub runtime: StrictLeafIdentity,
    pub listener_digest: [u8; 32],
    pub admitted_facts_digest: [u8; 32],
    pub pid: u32,
    pub process_start_time: u64,
    pub process_digest: [u8; 32],
}

/// Authenticated facts for an admitted managed launch. `active_pid_digest`
/// binds this record to the complete canonical ActivePid record, rather than a
/// numeric PID or a pathname. It grants no adoption or recovery authority.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LaunchRecord {
    pub authority: Authority,
    pub serial: StrictLeafIdentity,
    pub token: StrictLeafIdentity,
    pub configuration: StrictLeafIdentity,
    pub runtime: StrictLeafIdentity,
    pub listener_digest: [u8; 32],
    pub admitted_facts_digest: [u8; 32],
    pub active_pid_digest: [u8; 32],
}

#[derive(Clone, Copy)]
struct EvidenceBinding {
    authority: Authority,
    serial: StrictLeafIdentity,
    token: StrictLeafIdentity,
    configuration: StrictLeafIdentity,
    runtime: StrictLeafIdentity,
    listener_digest: [u8; 32],
    admitted_facts_digest: [u8; 32],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecordBody {
    Serial(SerialRecord),
    Vacancy(VacancyRecord),
    Selector(SelectorRecord),
    Journal(JournalRecord),
    ActivePid(ActivePidRecord),
    Launch(LaunchRecord),
}

impl RecordBody {
    pub const fn kind_is_compatible(self, kind: RecordKind) -> bool {
        matches!(
            (self, kind),
            (Self::Serial(_), RecordKind::LifecycleSerial)
                | (
                    Self::Vacancy(_),
                    RecordKind::LifecycleVacant
                        | RecordKind::RestartVacant
                        | RecordKind::LaunchVacant
                        | RecordKind::PidVacant
                )
                | (Self::Selector(_), RecordKind::LifecycleSelector)
                | (Self::Journal(_), RecordKind::Journal)
                | (Self::ActivePid(_), RecordKind::ActivePid)
                | (Self::Launch(_), RecordKind::Launch)
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthenticatedRecord {
    pub kind: RecordKind,
    pub body: RecordBody,
    pub envelope_digest: [u8; 32],
    pub content_digest: [u8; 32],
    canonical: Vec<u8>,
}

impl AuthenticatedRecord {
    pub fn encode(kind: RecordKind, body: RecordBody, key: &TokenKey) -> Result<Self, RecordError> {
        if !body.kind_is_compatible(kind) {
            return Err(RecordError::KindBodyMismatch);
        }
        validate_body(body)?;
        let body_bytes = encode_body(body);
        let body_len = u32::try_from(body_bytes.len()).map_err(|_| RecordError::TooLarge)?;
        let mut canonical = Vec::with_capacity(HEADER_LEN + body_bytes.len() + 64);
        canonical.extend_from_slice(&MAGIC);
        canonical.extend_from_slice(&(kind as u16).to_le_bytes());
        canonical.extend_from_slice(&VERSION.to_le_bytes());
        canonical.extend_from_slice(&body_len.to_le_bytes());
        canonical.extend_from_slice(&body_bytes);
        let envelope_digest = sha256::digest(&canonical);
        canonical.extend_from_slice(&envelope_digest);
        let mac = persistence_mac(key, kind, &canonical);
        canonical.extend_from_slice(&mac);
        if canonical.len() > kind.maximum_bytes() {
            return Err(RecordError::TooLarge);
        }
        let content_digest = sha256::digest(&canonical);
        Ok(Self {
            kind,
            body,
            envelope_digest,
            content_digest,
            canonical,
        })
    }

    pub fn parse(bytes: &[u8], key: &TokenKey) -> Result<Self, RecordError> {
        if bytes.len() < HEADER_LEN + DIGEST_LEN + MAC_LEN {
            return Err(RecordError::Truncated);
        }
        if bytes[..4] != MAGIC {
            return Err(RecordError::BadMagic);
        }
        let kind = RecordKind::from_u16(read_u16(bytes, 4)).ok_or(RecordError::UnknownKind)?;
        if read_u16(bytes, 6) != VERSION {
            return Err(RecordError::UnsupportedVersion);
        }
        if bytes.len() > kind.maximum_bytes() {
            return Err(RecordError::TooLarge);
        }
        let body_len = read_u32(bytes, 8) as usize;
        let digest_offset = HEADER_LEN
            .checked_add(body_len)
            .ok_or(RecordError::TooLarge)?;
        let expected_len = digest_offset
            .checked_add(DIGEST_LEN + MAC_LEN)
            .ok_or(RecordError::TooLarge)?;
        if bytes.len() != expected_len {
            return Err(if bytes.len() < expected_len {
                RecordError::Truncated
            } else {
                RecordError::TrailingBytes
            });
        }

        // Structural and schema parsing intentionally precede any MAC computation.
        let body = decode_body(kind, &bytes[HEADER_LEN..digest_offset])?;
        validate_body(body)?;
        let observed_digest: [u8; 32] = bytes[digest_offset..digest_offset + DIGEST_LEN]
            .try_into()
            .expect("fixed digest");
        let expected_digest = sha256::digest(&bytes[..digest_offset]);
        if !constant_time_eq(&observed_digest, &expected_digest) {
            return Err(RecordError::DigestMismatch);
        }
        let observed_mac = &bytes[digest_offset + DIGEST_LEN..];
        if observed_mac.iter().all(|byte| *byte == 0) {
            return Err(RecordError::ZeroMac);
        }
        let expected_mac = persistence_mac(key, kind, &bytes[..digest_offset + DIGEST_LEN]);
        if !constant_time_eq(observed_mac, &expected_mac) {
            return Err(RecordError::MacMismatch);
        }
        Ok(Self {
            kind,
            body,
            envelope_digest: observed_digest,
            content_digest: sha256::digest(bytes),
            canonical: bytes.to_vec(),
        })
    }

    pub fn canonical_bytes(&self) -> &[u8] {
        &self.canonical
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecordError {
    InvalidToken,
    Truncated,
    TrailingBytes,
    BadMagic,
    UnknownKind,
    UnsupportedVersion,
    TooLarge,
    InvalidBody,
    KindBodyMismatch,
    DigestMismatch,
    ZeroMac,
    MacMismatch,
}

fn persistence_mac(key: &TokenKey, kind: RecordKind, envelope_through_digest: &[u8]) -> [u8; 32] {
    let mut input = Vec::with_capacity(MAC_DOMAIN.len() + 2 + envelope_through_digest.len());
    input.extend_from_slice(MAC_DOMAIN);
    input.extend_from_slice(&(kind as u16).to_le_bytes());
    input.extend_from_slice(envelope_through_digest);
    sha256::hmac(key.bytes(), &input)
}

fn validate_body(body: RecordBody) -> Result<(), RecordError> {
    match body {
        RecordBody::Serial(record) => {
            validate_authority(record.authority)?;
            validate_serial_identity(record.self_identity)
        }
        RecordBody::Vacancy(record) => {
            validate_authority(record.authority)?;
            validate_strict_identity(record.serial)
        }
        RecordBody::Selector(record) => {
            validate_operation(
                record.operation_id,
                record.terminal_slot,
                record.phase_bitmap,
            )?;
            validate_strict_identity(record.serial)?;
            validate_strict_identity(record.predecessor)?;
            validate_strict_identity(record.token)?;
            validate_digest(record.preflight_digest)?;
            validate_digest(record.expected_pid_digest)?;
            validate_digest(record.expected_launch_digest)
        }
        RecordBody::Journal(record) => {
            validate_operation(
                record.operation_id,
                record.terminal_slot,
                record.phase_bitmap,
            )?;
            validate_strict_identity(record.serial)?;
            validate_strict_identity(record.lifecycle_predecessor)?;
            validate_strict_identity(record.restart_predecessor)?;
            validate_strict_identity(record.token)?;
            validate_digest(record.preflight_digest)?;
            validate_digest(record.expected_pid_digest)?;
            validate_digest(record.expected_launch_digest)
        }
        RecordBody::ActivePid(record) => validate_active_pid_record(record),
        RecordBody::Launch(record) => validate_launch_record(record),
    }
}

fn validate_evidence_binding(binding: EvidenceBinding) -> Result<(), RecordError> {
    validate_authority(binding.authority)?;
    validate_strict_identity(binding.serial)?;
    validate_strict_identity(binding.token)?;
    validate_strict_identity(binding.configuration)?;
    validate_strict_identity(binding.runtime)?;
    validate_digest(binding.listener_digest)?;
    validate_digest(binding.admitted_facts_digest)
}

fn validate_active_pid_record(record: ActivePidRecord) -> Result<(), RecordError> {
    validate_evidence_binding(active_pid_binding(record))?;
    if record.pid == 0 || record.process_start_time == 0 {
        return Err(RecordError::InvalidBody);
    }
    validate_digest(record.process_digest)
}

fn validate_launch_record(record: LaunchRecord) -> Result<(), RecordError> {
    validate_evidence_binding(launch_binding(record))?;
    validate_digest(record.active_pid_digest)
}

fn validate_authority(authority: Authority) -> Result<(), RecordError> {
    validate_directory_identity(authority.state_root)?;
    validate_directory_identity(authority.recovery_root)?;
    validate_digest(authority.helper_digest)
}

fn validate_directory_identity(identity: StableDirectoryIdentity) -> Result<(), RecordError> {
    if identity.device == 0 || identity.inode == 0 || identity.mode > 0o7777 {
        return Err(RecordError::InvalidBody);
    }
    Ok(())
}

fn validate_serial_identity(identity: SerialSelfIdentity) -> Result<(), RecordError> {
    if identity.device == 0
        || identity.inode == 0
        || identity.mode > 0o7777
        || identity.link_count == 0
    {
        return Err(RecordError::InvalidBody);
    }
    Ok(())
}

fn validate_strict_identity(identity: StrictLeafIdentity) -> Result<(), RecordError> {
    if identity.device == 0
        || identity.inode == 0
        || identity.mode > 0o7777
        || identity.link_count == 0
    {
        return Err(RecordError::InvalidBody);
    }
    validate_digest(identity.content_digest)
}

fn validate_operation(
    operation_id: [u8; 32],
    terminal_slot: u8,
    phase_bitmap: u64,
) -> Result<(), RecordError> {
    validate_digest(operation_id)?;
    if terminal_slot > 2 || phase_bitmap & !KNOWN_PHASE_MASK != 0 {
        return Err(RecordError::InvalidBody);
    }
    Ok(())
}

fn validate_digest(digest: [u8; 32]) -> Result<(), RecordError> {
    if digest.iter().all(|byte| *byte == 0) {
        return Err(RecordError::InvalidBody);
    }
    Ok(())
}

fn encode_body(body: RecordBody) -> Vec<u8> {
    let mut bytes = Vec::new();
    match body {
        RecordBody::Serial(record) => {
            encode_authority(&mut bytes, record.authority);
            encode_serial_identity(&mut bytes, record.self_identity);
        }
        RecordBody::Vacancy(record) => {
            encode_authority(&mut bytes, record.authority);
            encode_strict_identity(&mut bytes, record.serial);
        }
        RecordBody::Selector(record) => {
            encode_operation_prefix(
                &mut bytes,
                record.operation_id,
                record.operation_kind,
                record.terminal_slot,
                record.phase_bitmap,
            );
            encode_strict_identity(&mut bytes, record.serial);
            encode_strict_identity(&mut bytes, record.predecessor);
            encode_strict_identity(&mut bytes, record.token);
            bytes.extend_from_slice(&record.preflight_digest);
            bytes.extend_from_slice(&record.expected_pid_digest);
            bytes.extend_from_slice(&record.expected_launch_digest);
        }
        RecordBody::Journal(record) => {
            encode_operation_prefix(
                &mut bytes,
                record.operation_id,
                record.operation_kind,
                record.terminal_slot,
                record.phase_bitmap,
            );
            encode_strict_identity(&mut bytes, record.serial);
            encode_strict_identity(&mut bytes, record.lifecycle_predecessor);
            encode_strict_identity(&mut bytes, record.restart_predecessor);
            encode_strict_identity(&mut bytes, record.token);
            bytes.extend_from_slice(&record.preflight_digest);
            bytes.extend_from_slice(&record.expected_pid_digest);
            bytes.extend_from_slice(&record.expected_launch_digest);
        }
        RecordBody::ActivePid(record) => {
            encode_evidence_binding(&mut bytes, active_pid_binding(record));
            bytes.extend_from_slice(&record.pid.to_le_bytes());
            bytes.extend_from_slice(&record.process_start_time.to_le_bytes());
            bytes.extend_from_slice(&record.process_digest);
        }
        RecordBody::Launch(record) => {
            encode_evidence_binding(&mut bytes, launch_binding(record));
            bytes.extend_from_slice(&record.active_pid_digest);
        }
    }
    bytes
}

fn decode_body(kind: RecordKind, bytes: &[u8]) -> Result<RecordBody, RecordError> {
    let mut decoder = Decoder::new(bytes);
    let body = match kind {
        RecordKind::LifecycleSerial => RecordBody::Serial(SerialRecord {
            authority: decoder.authority()?,
            self_identity: decoder.serial_identity()?,
        }),
        RecordKind::LifecycleVacant
        | RecordKind::RestartVacant
        | RecordKind::LaunchVacant
        | RecordKind::PidVacant => RecordBody::Vacancy(VacancyRecord {
            authority: decoder.authority()?,
            serial: decoder.strict_identity()?,
        }),
        RecordKind::LifecycleSelector => {
            let (operation_id, operation_kind, terminal_slot, phase_bitmap) =
                decoder.operation()?;
            RecordBody::Selector(SelectorRecord {
                operation_id,
                operation_kind,
                terminal_slot,
                phase_bitmap,
                serial: decoder.strict_identity()?,
                predecessor: decoder.strict_identity()?,
                token: decoder.strict_identity()?,
                preflight_digest: decoder.digest()?,
                expected_pid_digest: decoder.digest()?,
                expected_launch_digest: decoder.digest()?,
            })
        }
        RecordKind::Journal => {
            let (operation_id, operation_kind, terminal_slot, phase_bitmap) =
                decoder.operation()?;
            RecordBody::Journal(JournalRecord {
                operation_id,
                operation_kind,
                terminal_slot,
                phase_bitmap,
                serial: decoder.strict_identity()?,
                lifecycle_predecessor: decoder.strict_identity()?,
                restart_predecessor: decoder.strict_identity()?,
                token: decoder.strict_identity()?,
                preflight_digest: decoder.digest()?,
                expected_pid_digest: decoder.digest()?,
                expected_launch_digest: decoder.digest()?,
            })
        }
        RecordKind::ActivePid => {
            let binding = decoder.evidence_binding()?;
            RecordBody::ActivePid(ActivePidRecord {
                authority: binding.authority,
                serial: binding.serial,
                token: binding.token,
                configuration: binding.configuration,
                runtime: binding.runtime,
                listener_digest: binding.listener_digest,
                admitted_facts_digest: binding.admitted_facts_digest,
                pid: decoder.u32()?,
                process_start_time: decoder.u64()?,
                process_digest: decoder.digest()?,
            })
        }
        RecordKind::Launch => {
            let binding = decoder.evidence_binding()?;
            RecordBody::Launch(LaunchRecord {
                authority: binding.authority,
                serial: binding.serial,
                token: binding.token,
                configuration: binding.configuration,
                runtime: binding.runtime,
                listener_digest: binding.listener_digest,
                admitted_facts_digest: binding.admitted_facts_digest,
                active_pid_digest: decoder.digest()?,
            })
        }
    };
    if !decoder.is_finished() {
        return Err(RecordError::InvalidBody);
    }
    Ok(body)
}

fn encode_authority(bytes: &mut Vec<u8>, authority: Authority) {
    encode_directory_identity(bytes, authority.state_root);
    encode_directory_identity(bytes, authority.recovery_root);
    bytes.extend_from_slice(&authority.helper_digest);
}

fn encode_evidence_binding(bytes: &mut Vec<u8>, binding: EvidenceBinding) {
    encode_authority(bytes, binding.authority);
    encode_strict_identity(bytes, binding.serial);
    encode_strict_identity(bytes, binding.token);
    encode_strict_identity(bytes, binding.configuration);
    encode_strict_identity(bytes, binding.runtime);
    bytes.extend_from_slice(&binding.listener_digest);
    bytes.extend_from_slice(&binding.admitted_facts_digest);
}

fn active_pid_binding(record: ActivePidRecord) -> EvidenceBinding {
    EvidenceBinding {
        authority: record.authority,
        serial: record.serial,
        token: record.token,
        configuration: record.configuration,
        runtime: record.runtime,
        listener_digest: record.listener_digest,
        admitted_facts_digest: record.admitted_facts_digest,
    }
}

fn launch_binding(record: LaunchRecord) -> EvidenceBinding {
    EvidenceBinding {
        authority: record.authority,
        serial: record.serial,
        token: record.token,
        configuration: record.configuration,
        runtime: record.runtime,
        listener_digest: record.listener_digest,
        admitted_facts_digest: record.admitted_facts_digest,
    }
}

fn encode_directory_identity(bytes: &mut Vec<u8>, identity: StableDirectoryIdentity) {
    bytes.push(1);
    bytes.extend_from_slice(&identity.device.to_le_bytes());
    bytes.extend_from_slice(&identity.inode.to_le_bytes());
    bytes.extend_from_slice(&identity.uid.to_le_bytes());
    bytes.extend_from_slice(&identity.gid.to_le_bytes());
    bytes.extend_from_slice(&identity.mode.to_le_bytes());
}

fn encode_strict_identity(bytes: &mut Vec<u8>, identity: StrictLeafIdentity) {
    bytes.push(2);
    bytes.extend_from_slice(&identity.device.to_le_bytes());
    bytes.extend_from_slice(&identity.inode.to_le_bytes());
    bytes.extend_from_slice(&identity.uid.to_le_bytes());
    bytes.extend_from_slice(&identity.gid.to_le_bytes());
    bytes.extend_from_slice(&identity.mode.to_le_bytes());
    bytes.extend_from_slice(&identity.link_count.to_le_bytes());
    bytes.extend_from_slice(&identity.size.to_le_bytes());
    bytes.extend_from_slice(&identity.content_digest);
}

fn encode_serial_identity(bytes: &mut Vec<u8>, identity: SerialSelfIdentity) {
    bytes.push(2);
    bytes.extend_from_slice(&identity.device.to_le_bytes());
    bytes.extend_from_slice(&identity.inode.to_le_bytes());
    bytes.extend_from_slice(&identity.uid.to_le_bytes());
    bytes.extend_from_slice(&identity.gid.to_le_bytes());
    bytes.extend_from_slice(&identity.mode.to_le_bytes());
    bytes.extend_from_slice(&identity.link_count.to_le_bytes());
}

fn encode_operation_prefix(
    bytes: &mut Vec<u8>,
    operation_id: [u8; 32],
    operation_kind: OperationKind,
    terminal_slot: u8,
    phase_bitmap: u64,
) {
    bytes.extend_from_slice(&operation_id);
    bytes.push(operation_kind as u8);
    bytes.push(terminal_slot);
    bytes.extend_from_slice(&0_u16.to_le_bytes());
    bytes.extend_from_slice(&phase_bitmap.to_le_bytes());
}

struct Decoder<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Decoder<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], RecordError> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or(RecordError::InvalidBody)?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or(RecordError::InvalidBody)?;
        self.offset = end;
        Ok(value)
    }

    fn u8(&mut self) -> Result<u8, RecordError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, RecordError> {
        Ok(u16::from_le_bytes(
            self.take(2)?.try_into().expect("two bytes"),
        ))
    }

    fn u32(&mut self) -> Result<u32, RecordError> {
        Ok(u32::from_le_bytes(
            self.take(4)?.try_into().expect("four bytes"),
        ))
    }

    fn u64(&mut self) -> Result<u64, RecordError> {
        Ok(u64::from_le_bytes(
            self.take(8)?.try_into().expect("eight bytes"),
        ))
    }

    fn digest(&mut self) -> Result<[u8; 32], RecordError> {
        Ok(self.take(32)?.try_into().expect("digest bytes"))
    }

    fn directory_identity(&mut self) -> Result<StableDirectoryIdentity, RecordError> {
        if self.u8()? != 1 {
            return Err(RecordError::InvalidBody);
        }
        Ok(StableDirectoryIdentity {
            device: self.u64()?,
            inode: self.u64()?,
            uid: self.u32()?,
            gid: self.u32()?,
            mode: self.u32()?,
        })
    }

    fn strict_identity(&mut self) -> Result<StrictLeafIdentity, RecordError> {
        if self.u8()? != 2 {
            return Err(RecordError::InvalidBody);
        }
        Ok(StrictLeafIdentity {
            device: self.u64()?,
            inode: self.u64()?,
            uid: self.u32()?,
            gid: self.u32()?,
            mode: self.u32()?,
            link_count: self.u64()?,
            size: self.u64()?,
            content_digest: self.digest()?,
        })
    }

    fn serial_identity(&mut self) -> Result<SerialSelfIdentity, RecordError> {
        if self.u8()? != 2 {
            return Err(RecordError::InvalidBody);
        }
        Ok(SerialSelfIdentity {
            device: self.u64()?,
            inode: self.u64()?,
            uid: self.u32()?,
            gid: self.u32()?,
            mode: self.u32()?,
            link_count: self.u64()?,
        })
    }

    fn authority(&mut self) -> Result<Authority, RecordError> {
        Ok(Authority {
            state_root: self.directory_identity()?,
            recovery_root: self.directory_identity()?,
            helper_digest: self.digest()?,
        })
    }

    fn evidence_binding(&mut self) -> Result<EvidenceBinding, RecordError> {
        Ok(EvidenceBinding {
            authority: self.authority()?,
            serial: self.strict_identity()?,
            token: self.strict_identity()?,
            configuration: self.strict_identity()?,
            runtime: self.strict_identity()?,
            listener_digest: self.digest()?,
            admitted_facts_digest: self.digest()?,
        })
    }

    fn operation(&mut self) -> Result<([u8; 32], OperationKind, u8, u64), RecordError> {
        let operation_id = self.digest()?;
        let operation_kind = OperationKind::from_u8(self.u8()?).ok_or(RecordError::InvalidBody)?;
        let terminal_slot = self.u8()?;
        if self.u16()? != 0 {
            return Err(RecordError::InvalidBody);
        }
        let phase_bitmap = self.u64()?;
        Ok((operation_id, operation_kind, terminal_slot, phase_bitmap))
    }

    fn is_finished(&self) -> bool {
        self.offset == self.bytes.len()
    }
}

fn read_u16(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(
        bytes[offset..offset + 2]
            .try_into()
            .expect("checked record"),
    )
}

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .expect("checked record"),
    )
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .fold(0_u8, |difference, (left, right)| {
                difference | (left ^ right)
            })
            == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(byte: u8) -> TokenKey {
        let token = [byte; 64];
        TokenKey::parse(&token).unwrap()
    }

    fn stable(seed: u64) -> StableDirectoryIdentity {
        StableDirectoryIdentity {
            device: seed,
            inode: seed + 1,
            uid: 1000,
            gid: 1000,
            mode: 0o700,
        }
    }

    fn strict(seed: u64) -> StrictLeafIdentity {
        StrictLeafIdentity {
            device: seed,
            inode: seed + 1,
            uid: 1000,
            gid: 1000,
            mode: 0o600,
            link_count: 1,
            size: 100,
            content_digest: [seed as u8; 32],
        }
    }

    fn authority() -> Authority {
        Authority {
            state_root: stable(1),
            recovery_root: stable(3),
            helper_digest: [5; 32],
        }
    }

    fn vacancy() -> RecordBody {
        RecordBody::Vacancy(VacancyRecord {
            authority: authority(),
            serial: strict(7),
        })
    }

    fn journal() -> RecordBody {
        RecordBody::Journal(JournalRecord {
            operation_id: [9; 32],
            operation_kind: OperationKind::InitialStart,
            terminal_slot: 0,
            phase_bitmap: 1,
            serial: strict(10),
            lifecycle_predecessor: strict(20),
            restart_predecessor: strict(30),
            token: strict(40),
            preflight_digest: [50; 32],
            expected_pid_digest: [51; 32],
            expected_launch_digest: [52; 32],
        })
    }

    fn active_pid() -> ActivePidRecord {
        ActivePidRecord {
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
        }
    }

    fn launch() -> LaunchRecord {
        LaunchRecord {
            authority: authority(),
            serial: strict(10),
            token: strict(20),
            configuration: strict(30),
            runtime: strict(40),
            listener_digest: [50; 32],
            admitted_facts_digest: [60; 32],
            active_pid_digest: [80; 32],
        }
    }

    #[test]
    fn accepts_only_canonical_lowercase_token_bytes() {
        assert!(TokenKey::parse(&[b'a'; 64]).is_ok());
        assert!(matches!(
            TokenKey::parse(&[b'A'; 64]),
            Err(RecordError::InvalidToken)
        ));
        assert!(matches!(
            TokenKey::parse(&[b'g'; 64]),
            Err(RecordError::InvalidToken)
        ));
        assert!(matches!(
            TokenKey::parse(&[b'a'; 63]),
            Err(RecordError::InvalidToken)
        ));
        assert_eq!(format!("{:?}", key(b'a')), "TokenKey([REDACTED])");
    }

    #[test]
    fn round_trips_each_supported_fixed_schema() {
        let bodies = [
            (
                RecordKind::LifecycleSerial,
                RecordBody::Serial(SerialRecord {
                    authority: authority(),
                    self_identity: SerialSelfIdentity {
                        device: 6,
                        inode: 7,
                        uid: 1000,
                        gid: 1000,
                        mode: 0o600,
                        link_count: 1,
                    },
                }),
            ),
            (RecordKind::LifecycleVacant, vacancy()),
            (RecordKind::RestartVacant, vacancy()),
            (RecordKind::LaunchVacant, vacancy()),
            (RecordKind::PidVacant, vacancy()),
            (
                RecordKind::LifecycleSelector,
                RecordBody::Selector(SelectorRecord {
                    operation_id: [9; 32],
                    operation_kind: OperationKind::Rotation,
                    terminal_slot: 1,
                    phase_bitmap: 3,
                    serial: strict(10),
                    predecessor: strict(20),
                    token: strict(30),
                    preflight_digest: [40; 32],
                    expected_pid_digest: [41; 32],
                    expected_launch_digest: [42; 32],
                }),
            ),
            (RecordKind::Journal, journal()),
            (RecordKind::ActivePid, RecordBody::ActivePid(active_pid())),
            (RecordKind::Launch, RecordBody::Launch(launch())),
        ];
        let key = key(b'a');
        for (kind, body) in bodies {
            let record = AuthenticatedRecord::encode(kind, body, &key).unwrap();
            assert_eq!(
                AuthenticatedRecord::parse(record.canonical_bytes(), &key),
                Ok(record)
            );
        }
    }

    #[test]
    fn rejects_substitution_and_wrong_domain_key() {
        let current_key = key(b'a');
        let record =
            AuthenticatedRecord::encode(RecordKind::RestartVacant, vacancy(), &current_key)
                .unwrap();
        assert_eq!(
            AuthenticatedRecord::parse(record.canonical_bytes(), &key(b'b')),
            Err(RecordError::MacMismatch)
        );
        let mut changed = record.canonical_bytes().to_vec();
        changed[12] ^= 1;
        assert_eq!(
            AuthenticatedRecord::parse(&changed, &current_key),
            Err(RecordError::InvalidBody)
        );

        let launch = AuthenticatedRecord::encode(
            RecordKind::Launch,
            RecordBody::Launch(launch()),
            &current_key,
        )
        .unwrap();
        let mut substituted_kind = launch.canonical_bytes().to_vec();
        substituted_kind[4..6].copy_from_slice(&(RecordKind::ActivePid as u16).to_le_bytes());
        let digest_offset = substituted_kind.len() - MAC_LEN - DIGEST_LEN;
        let digest = sha256::digest(&substituted_kind[..digest_offset]);
        substituted_kind[digest_offset..digest_offset + DIGEST_LEN].copy_from_slice(&digest);
        assert_eq!(
            AuthenticatedRecord::parse(&substituted_kind, &current_key),
            Err(RecordError::InvalidBody)
        );

        let vacant =
            AuthenticatedRecord::encode(RecordKind::RestartVacant, vacancy(), &current_key)
                .unwrap();
        let mut domain_substitution = vacant.canonical_bytes().to_vec();
        domain_substitution[4..6].copy_from_slice(&(RecordKind::PidVacant as u16).to_le_bytes());
        let digest_offset = domain_substitution.len() - MAC_LEN - DIGEST_LEN;
        let digest = sha256::digest(&domain_substitution[..digest_offset]);
        domain_substitution[digest_offset..digest_offset + DIGEST_LEN].copy_from_slice(&digest);
        assert_eq!(
            AuthenticatedRecord::parse(&domain_substitution, &current_key),
            Err(RecordError::MacMismatch)
        );
    }

    #[test]
    fn structural_rejection_precedes_mac_use() {
        let key = key(b'a');
        let record = AuthenticatedRecord::encode(RecordKind::Journal, journal(), &key).unwrap();
        let mut malformed = record.canonical_bytes().to_vec();
        let operation_kind_offset = HEADER_LEN + 32;
        malformed[operation_kind_offset] = 0xff;
        let mac_offset = malformed.len() - MAC_LEN;
        malformed[mac_offset..].fill(0);
        assert_eq!(
            AuthenticatedRecord::parse(&malformed, &key),
            Err(RecordError::InvalidBody)
        );
    }

    #[test]
    fn rejects_zero_mac_trailing_data_and_body_kind_mismatch() {
        let key = key(b'a');
        let record =
            AuthenticatedRecord::encode(RecordKind::RestartVacant, vacancy(), &key).unwrap();
        let mut zero_mac = record.canonical_bytes().to_vec();
        let mac_offset = zero_mac.len() - MAC_LEN;
        zero_mac[mac_offset..].fill(0);
        assert_eq!(
            AuthenticatedRecord::parse(&zero_mac, &key),
            Err(RecordError::ZeroMac)
        );
        let mut trailing = record.canonical_bytes().to_vec();
        trailing.push(0);
        assert_eq!(
            AuthenticatedRecord::parse(&trailing, &key),
            Err(RecordError::TrailingBytes)
        );
        assert_eq!(
            AuthenticatedRecord::encode(RecordKind::Journal, vacancy(), &key),
            Err(RecordError::KindBodyMismatch)
        );
    }

    #[test]
    fn self_referential_and_unknown_phase_fields_fail_closed() {
        let key = key(b'a');
        let mut body = match journal() {
            RecordBody::Journal(record) => record,
            _ => unreachable!(),
        };
        body.phase_bitmap = 1 << 63;
        assert_eq!(
            AuthenticatedRecord::encode(RecordKind::Journal, RecordBody::Journal(body), &key),
            Err(RecordError::InvalidBody)
        );
        body.phase_bitmap = 1;
        body.operation_id = [0; 32];
        assert_eq!(
            AuthenticatedRecord::encode(RecordKind::Journal, RecordBody::Journal(body), &key),
            Err(RecordError::InvalidBody)
        );
    }

    #[test]
    fn active_evidence_has_fixed_canonical_order_and_rejects_alternates() {
        let key = key(b'a');
        let record = AuthenticatedRecord::encode(
            RecordKind::ActivePid,
            RecordBody::ActivePid(active_pid()),
            &key,
        )
        .unwrap();
        let bytes = record.canonical_bytes();
        let body = &bytes[HEADER_LEN..bytes.len() - DIGEST_LEN - MAC_LEN];
        assert_eq!(body.len(), 506);
        assert_eq!(body[0], 1, "state-root identity comes first");
        assert_eq!(body[29], 1, "recovery-root identity follows state-root");
        assert_eq!(body[90], 2, "serial follows authority");
        assert_eq!(body[167], 2, "token follows serial");
        assert_eq!(body[244], 2, "configuration follows token");
        assert_eq!(body[321], 2, "runtime follows configuration");
        assert_eq!(body[398..430], [50; 32], "listener digest follows runtime");
        assert_eq!(
            body[430..462],
            [60; 32],
            "admitted facts follow listener digest"
        );
        assert_eq!(body[462..466], 1234_u32.to_le_bytes());
        assert_eq!(body[466..474], 5678_u64.to_le_bytes());
        assert_eq!(body[474..506], [70; 32]);

        let mut alternate_tag = bytes.to_vec();
        alternate_tag[HEADER_LEN + 244] = 3;
        assert_eq!(
            AuthenticatedRecord::parse(&alternate_tag, &key),
            Err(RecordError::InvalidBody)
        );
        let mut reserved_header = bytes.to_vec();
        reserved_header[6..8].copy_from_slice(&2_u16.to_le_bytes());
        assert_eq!(
            AuthenticatedRecord::parse(&reserved_header, &key),
            Err(RecordError::UnsupportedVersion)
        );
    }

    #[test]
    fn active_evidence_rejects_zero_or_tampered_binding_facts() {
        let key = key(b'a');
        let mut pid = active_pid();
        pid.pid = 0;
        assert_eq!(
            AuthenticatedRecord::encode(RecordKind::ActivePid, RecordBody::ActivePid(pid), &key),
            Err(RecordError::InvalidBody)
        );
        let mut invalid_launch = launch();
        invalid_launch.active_pid_digest = [0; 32];
        assert_eq!(
            AuthenticatedRecord::encode(
                RecordKind::Launch,
                RecordBody::Launch(invalid_launch),
                &key
            ),
            Err(RecordError::InvalidBody)
        );
        let record =
            AuthenticatedRecord::encode(RecordKind::Launch, RecordBody::Launch(launch()), &key)
                .unwrap();
        let mut tampered = record.canonical_bytes().to_vec();
        tampered[HEADER_LEN + 398] ^= 1;
        assert_eq!(
            AuthenticatedRecord::parse(&tampered, &key),
            Err(RecordError::DigestMismatch)
        );
    }
}
