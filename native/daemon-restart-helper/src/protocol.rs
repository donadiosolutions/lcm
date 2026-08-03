//! Canonical version-1 helper IPC framing.

use crate::sha256;

pub const HEADER_LEN: usize = 120;
pub const MAX_PAYLOAD_LEN: usize = 8_192;
pub const ABORT_REASON_REQUESTED: u16 = 1;
const CHECKSUM_INPUT_LEN: usize = 88;
const MAGIC: [u8; 4] = *b"LCMR";
const VERSION: u16 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u16)]
pub enum RequestKind {
    Bootstrap = 0x0001,
    OpenStable = 0x0002,
    VerifyExisting = 0x0003,
    ResumeActive = 0x0004,
    PrepareStart = 0x0005,
    RetireDead = 0x0006,
    LaunchManaged = 0x0007,
    Recover = 0x0008,
    LaunchReplacement = 0x0009,
    PublishPid = 0x000a,
    AdmitHealthy = 0x000b,
    Abort = 0x000c,
}

impl RequestKind {
    fn from_u16(value: u16) -> Option<Self> {
        Some(match value {
            0x0001 => Self::Bootstrap,
            0x0002 => Self::OpenStable,
            0x0003 => Self::VerifyExisting,
            0x0004 => Self::ResumeActive,
            0x0005 => Self::PrepareStart,
            0x0006 => Self::RetireDead,
            0x0007 => Self::LaunchManaged,
            0x0008 => Self::Recover,
            0x0009 => Self::LaunchReplacement,
            0x000a => Self::PublishPid,
            0x000b => Self::AdmitHealthy,
            0x000c => Self::Abort,
            _ => return None,
        })
    }

    const fn is_handshake(self) -> bool {
        matches!(
            self,
            Self::Bootstrap | Self::OpenStable | Self::ResumeActive
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MessageKind {
    Request(RequestKind),
    Response(RequestKind),
}

impl MessageKind {
    fn from_u16(value: u16) -> Option<Self> {
        if value & 0x8000 == 0 {
            RequestKind::from_u16(value).map(Self::Request)
        } else {
            RequestKind::from_u16(value & !0x8000).map(Self::Response)
        }
    }

    const fn to_u16(self) -> u16 {
        match self {
            Self::Request(kind) => kind as u16,
            Self::Response(kind) => (kind as u16) | 0x8000,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Frame {
    pub kind: MessageKind,
    pub session_id: [u8; 32],
    pub ordinal: u64,
    pub request_id: [u8; 32],
    pub payload: Vec<u8>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProtocolError {
    ShortFrame,
    ExcessBytes,
    BadMagic,
    UnsupportedVersion,
    UnknownKind,
    NonzeroFlags,
    PayloadTooLarge,
    ChecksumMismatch,
    ZeroRequestId,
    InvalidSession,
    InvalidOrdinal,
    InvalidPayload,
    UnknownResultCode,
    UnknownPhase,
}

impl Frame {
    pub fn decode(bytes: &[u8]) -> Result<Self, ProtocolError> {
        if bytes.len() < HEADER_LEN {
            return Err(ProtocolError::ShortFrame);
        }
        if bytes[0..4] != MAGIC {
            return Err(ProtocolError::BadMagic);
        }
        if read_u16(bytes, 4) != VERSION {
            return Err(ProtocolError::UnsupportedVersion);
        }
        let kind = MessageKind::from_u16(read_u16(bytes, 6)).ok_or(ProtocolError::UnknownKind)?;
        if read_u32(bytes, 8) != 0 {
            return Err(ProtocolError::NonzeroFlags);
        }
        let payload_len = read_u32(bytes, 84) as usize;
        if payload_len > MAX_PAYLOAD_LEN {
            return Err(ProtocolError::PayloadTooLarge);
        }
        let frame_len = HEADER_LEN
            .checked_add(payload_len)
            .ok_or(ProtocolError::PayloadTooLarge)?;
        match bytes.len().cmp(&frame_len) {
            core::cmp::Ordering::Less => return Err(ProtocolError::ShortFrame),
            core::cmp::Ordering::Greater => return Err(ProtocolError::ExcessBytes),
            core::cmp::Ordering::Equal => {}
        }

        let mut checksum_input = Vec::with_capacity(CHECKSUM_INPUT_LEN + payload_len);
        checksum_input.extend_from_slice(&bytes[..CHECKSUM_INPUT_LEN]);
        checksum_input.extend_from_slice(&bytes[HEADER_LEN..]);
        if !constant_time_eq(&sha256::digest(&checksum_input), &bytes[88..120]) {
            return Err(ProtocolError::ChecksumMismatch);
        }

        let frame = Self {
            kind,
            session_id: bytes[12..44].try_into().expect("fixed session field"),
            ordinal: read_u64(bytes, 44),
            request_id: bytes[52..84].try_into().expect("fixed request field"),
            payload: bytes[HEADER_LEN..].to_vec(),
        };
        frame.validate()?;
        Ok(frame)
    }

    pub fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        self.validate()?;
        let payload_len =
            u32::try_from(self.payload.len()).map_err(|_| ProtocolError::PayloadTooLarge)?;
        let mut bytes = vec![0_u8; HEADER_LEN + self.payload.len()];
        bytes[0..4].copy_from_slice(&MAGIC);
        bytes[4..6].copy_from_slice(&VERSION.to_le_bytes());
        bytes[6..8].copy_from_slice(&self.kind.to_u16().to_le_bytes());
        bytes[12..44].copy_from_slice(&self.session_id);
        bytes[44..52].copy_from_slice(&self.ordinal.to_le_bytes());
        bytes[52..84].copy_from_slice(&self.request_id);
        bytes[84..88].copy_from_slice(&payload_len.to_le_bytes());
        bytes[HEADER_LEN..].copy_from_slice(&self.payload);

        let mut checksum_input = Vec::with_capacity(CHECKSUM_INPUT_LEN + self.payload.len());
        checksum_input.extend_from_slice(&bytes[..CHECKSUM_INPUT_LEN]);
        checksum_input.extend_from_slice(&self.payload);
        bytes[88..120].copy_from_slice(&sha256::digest(&checksum_input));
        Ok(bytes)
    }

    fn validate(&self) -> Result<(), ProtocolError> {
        if self.payload.len() > MAX_PAYLOAD_LEN {
            return Err(ProtocolError::PayloadTooLarge);
        }
        if all_zero(&self.request_id) {
            return Err(ProtocolError::ZeroRequestId);
        }
        validate_session(self.kind, &self.session_id, self.ordinal)?;
        match self.kind {
            MessageKind::Request(kind) => validate_request_payload(kind, &self.payload),
            MessageKind::Response(_) => validate_response_payload(&self.payload),
        }
    }
}

fn validate_session(
    message_kind: MessageKind,
    session_id: &[u8; 32],
    ordinal: u64,
) -> Result<(), ProtocolError> {
    let session_is_zero = all_zero(session_id);
    match message_kind {
        MessageKind::Request(kind) if kind.is_handshake() => {
            if !session_is_zero {
                return Err(ProtocolError::InvalidSession);
            }
            if ordinal != 0 {
                return Err(ProtocolError::InvalidOrdinal);
            }
        }
        MessageKind::Request(_) => {
            if session_is_zero {
                return Err(ProtocolError::InvalidSession);
            }
            if ordinal == 0 {
                return Err(ProtocolError::InvalidOrdinal);
            }
        }
        MessageKind::Response(RequestKind::Bootstrap) => {
            if !session_is_zero {
                return Err(ProtocolError::InvalidSession);
            }
            if ordinal != 0 {
                return Err(ProtocolError::InvalidOrdinal);
            }
        }
        MessageKind::Response(RequestKind::OpenStable | RequestKind::ResumeActive) => {
            if session_is_zero {
                return Err(ProtocolError::InvalidSession);
            }
            if ordinal != 0 {
                return Err(ProtocolError::InvalidOrdinal);
            }
        }
        MessageKind::Response(_) => {
            if session_is_zero {
                return Err(ProtocolError::InvalidSession);
            }
            if ordinal == 0 {
                return Err(ProtocolError::InvalidOrdinal);
            }
        }
    }
    Ok(())
}

fn validate_request_payload(kind: RequestKind, payload: &[u8]) -> Result<(), ProtocolError> {
    let valid = match kind {
        RequestKind::PrepareStart => matches!(payload, [1] | [2]),
        RequestKind::Recover => payload == [1],
        RequestKind::Abort => payload == ABORT_REASON_REQUESTED.to_le_bytes(),
        _ => payload.is_empty(),
    };
    valid.then_some(()).ok_or(ProtocolError::InvalidPayload)
}

fn validate_response_payload(payload: &[u8]) -> Result<(), ProtocolError> {
    if payload.len() < 8 {
        return Err(ProtocolError::InvalidPayload);
    }
    let result =
        ResultCode::from_u16(read_u16(payload, 0)).ok_or(ProtocolError::UnknownResultCode)?;
    DurablePhase::from_u16(read_u16(payload, 2)).ok_or(ProtocolError::UnknownPhase)?;
    let body_len = read_u32(payload, 4) as usize;
    if payload.len() != 8 + body_len {
        return Err(ProtocolError::InvalidPayload);
    }
    let expected = match result {
        ResultCode::OkSpawned => 12,
        ResultCode::OkPidPublished => 36,
        _ => 0,
    };
    if body_len != expected {
        return Err(ProtocolError::InvalidPayload);
    }
    if result == ResultCode::OkSpawned && read_u32(payload, 8) == 0 {
        return Err(ProtocolError::InvalidPayload);
    }
    if result == ResultCode::OkPidPublished && read_u32(payload, 8) == 0 {
        return Err(ProtocolError::InvalidPayload);
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u16)]
enum ResultCode {
    OkBootstrapped = 0x0001,
    OkOpenStable = 0x0002,
    OkResumed = 0x0003,
    OkVerified = 0x0004,
    OkPrepared = 0x0005,
    OkAdmitted = 0x0006,
    OkStopped = 0x0007,
    OkCompleted = 0x0008,
    OkAborted = 0x0009,
    OkSpawned = 0x000a,
    OkPidPublished = 0x000b,
    OkRetired = 0x000c,
    Protocol = 0x8001,
    Unsupported = 0x8002,
    Busy = 0x8003,
    Layout = 0x8004,
    Mac = 0x8005,
    Identity = 0x8006,
    Preflight = 0x8007,
    NoSlot = 0x8008,
    Phase = 0x8009,
    Io = 0x800a,
    Timeout = 0x800b,
}

impl ResultCode {
    fn from_u16(value: u16) -> Option<Self> {
        Some(match value {
            0x0001 => Self::OkBootstrapped,
            0x0002 => Self::OkOpenStable,
            0x0003 => Self::OkResumed,
            0x0004 => Self::OkVerified,
            0x0005 => Self::OkPrepared,
            0x0006 => Self::OkAdmitted,
            0x0007 => Self::OkStopped,
            0x0008 => Self::OkCompleted,
            0x0009 => Self::OkAborted,
            0x000a => Self::OkSpawned,
            0x000b => Self::OkPidPublished,
            0x000c => Self::OkRetired,
            0x8001 => Self::Protocol,
            0x8002 => Self::Unsupported,
            0x8003 => Self::Busy,
            0x8004 => Self::Layout,
            0x8005 => Self::Mac,
            0x8006 => Self::Identity,
            0x8007 => Self::Preflight,
            0x8008 => Self::NoSlot,
            0x8009 => Self::Phase,
            0x800a => Self::Io,
            0x800b => Self::Timeout,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u16)]
enum DurablePhase {
    Stable = 0x0000,
    Prepared = 0x0001,
    CandidateSpawned = 0x0002,
    PidPublished = 0x0003,
    TargetTerm = 0x0004,
    TargetKill = 0x0005,
    TargetExited = 0x0006,
    CandidateAbortTerm = 0x0007,
    CandidateAbortKill = 0x0008,
    CandidateAbortExited = 0x0009,
    Admitted = 0x000a,
    CommitReady = 0x000b,
    Sealed = 0x000c,
    SpawnIntent = 0x000d,
    SpawnRecorded = 0x000e,
}

impl DurablePhase {
    fn from_u16(value: u16) -> Option<Self> {
        Some(match value {
            0x0000 => Self::Stable,
            0x0001 => Self::Prepared,
            0x0002 => Self::CandidateSpawned,
            0x0003 => Self::PidPublished,
            0x0004 => Self::TargetTerm,
            0x0005 => Self::TargetKill,
            0x0006 => Self::TargetExited,
            0x0007 => Self::CandidateAbortTerm,
            0x0008 => Self::CandidateAbortKill,
            0x0009 => Self::CandidateAbortExited,
            0x000a => Self::Admitted,
            0x000b => Self::CommitReady,
            0x000c => Self::Sealed,
            0x000d => Self::SpawnIntent,
            0x000e => Self::SpawnRecorded,
            _ => return None,
        })
    }
}

fn read_u16(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(bytes[offset..offset + 2].try_into().expect("checked frame"))
}

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("checked frame"))
}

fn read_u64(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().expect("checked frame"))
}

fn all_zero(bytes: &[u8]) -> bool {
    bytes.iter().all(|byte| *byte == 0)
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

    fn request(kind: RequestKind, payload: Vec<u8>) -> Frame {
        let handshake = kind.is_handshake();
        Frame {
            kind: MessageKind::Request(kind),
            session_id: if handshake { [0; 32] } else { [7; 32] },
            ordinal: u64::from(!handshake),
            request_id: [9; 32],
            payload,
        }
    }

    #[test]
    fn exact_header_round_trip() {
        let frame = request(RequestKind::Bootstrap, Vec::new());
        let bytes = frame.encode().unwrap();
        assert_eq!(bytes.len(), HEADER_LEN);
        assert_eq!(&bytes[..4], b"LCMR");
        assert_eq!(Frame::decode(&bytes), Ok(frame));
    }

    #[test]
    fn accepts_all_canonical_request_payload_shapes() {
        for (kind, payload) in [
            (RequestKind::PrepareStart, vec![1]),
            (RequestKind::PrepareStart, vec![2]),
            (RequestKind::Recover, vec![1]),
            (
                RequestKind::Abort,
                ABORT_REASON_REQUESTED.to_le_bytes().to_vec(),
            ),
            (RequestKind::VerifyExisting, vec![]),
        ] {
            let frame = request(kind, payload);
            assert_eq!(Frame::decode(&frame.encode().unwrap()), Ok(frame));
        }
    }

    #[test]
    fn rejects_malformed_request_payloads() {
        for frame in [
            request(RequestKind::PrepareStart, vec![0]),
            request(RequestKind::PrepareStart, vec![1, 0]),
            request(RequestKind::Recover, vec![2]),
            request(RequestKind::Abort, vec![0, 0]),
            request(RequestKind::Abort, vec![2, 0]),
            request(RequestKind::PublishPid, vec![1]),
        ] {
            assert_eq!(frame.encode(), Err(ProtocolError::InvalidPayload));
        }
    }

    #[test]
    fn rejects_corruption_bounds_and_noncanonical_headers() {
        let bytes = request(RequestKind::Bootstrap, vec![]).encode().unwrap();
        for (offset, value, error) in [
            (0, b'X', ProtocolError::BadMagic),
            (4, 2, ProtocolError::UnsupportedVersion),
            (6, 0x7f, ProtocolError::UnknownKind),
            (8, 1, ProtocolError::NonzeroFlags),
        ] {
            let mut changed = bytes.clone();
            changed[offset] = value;
            assert_eq!(Frame::decode(&changed), Err(error));
        }
        let mut changed = bytes.clone();
        changed[88] ^= 1;
        assert_eq!(
            Frame::decode(&changed),
            Err(ProtocolError::ChecksumMismatch)
        );
        assert_eq!(Frame::decode(&bytes[..119]), Err(ProtocolError::ShortFrame));
        let mut excess = bytes;
        excess.push(0);
        assert_eq!(Frame::decode(&excess), Err(ProtocolError::ExcessBytes));
    }

    #[test]
    fn rejects_oversize_before_allocating_payload() {
        let mut bytes = vec![0_u8; HEADER_LEN];
        bytes[..4].copy_from_slice(b"LCMR");
        bytes[4..6].copy_from_slice(&1_u16.to_le_bytes());
        bytes[6..8].copy_from_slice(&(RequestKind::Bootstrap as u16).to_le_bytes());
        bytes[84..88].copy_from_slice(&((MAX_PAYLOAD_LEN as u32) + 1).to_le_bytes());
        assert_eq!(Frame::decode(&bytes), Err(ProtocolError::PayloadTooLarge));
    }

    #[test]
    fn fails_closed_on_session_and_request_ambiguity() {
        let mut frame = request(RequestKind::Bootstrap, vec![]);
        frame.request_id = [0; 32];
        assert_eq!(frame.encode(), Err(ProtocolError::ZeroRequestId));

        let mut frame = request(RequestKind::VerifyExisting, vec![]);
        frame.session_id = [0; 32];
        assert_eq!(frame.encode(), Err(ProtocolError::InvalidSession));

        let mut frame = request(RequestKind::OpenStable, vec![]);
        frame.ordinal = 1;
        assert_eq!(frame.encode(), Err(ProtocolError::InvalidOrdinal));
    }

    #[test]
    fn validates_bounded_response_schema() {
        let response = Frame {
            kind: MessageKind::Response(RequestKind::LaunchManaged),
            session_id: [3; 32],
            ordinal: 1,
            request_id: [4; 32],
            payload: [
                0x000a_u16.to_le_bytes().as_slice(),
                0x0002_u16.to_le_bytes().as_slice(),
                12_u32.to_le_bytes().as_slice(),
                42_u32.to_le_bytes().as_slice(),
                99_u64.to_le_bytes().as_slice(),
            ]
            .concat(),
        };
        assert_eq!(Frame::decode(&response.encode().unwrap()), Ok(response));

        let mut invalid = Frame {
            kind: MessageKind::Response(RequestKind::Bootstrap),
            session_id: [0; 32],
            ordinal: 0,
            request_id: [4; 32],
            payload: vec![1, 0, 0, 0, 1, 0, 0, 0, 0],
        };
        assert_eq!(invalid.encode(), Err(ProtocolError::InvalidPayload));
        invalid.payload = vec![0xff, 0xff, 0, 0, 0, 0, 0, 0];
        assert_eq!(invalid.encode(), Err(ProtocolError::UnknownResultCode));
    }
}
