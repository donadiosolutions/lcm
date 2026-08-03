//! Read-only admission for the fixed version-1 inherited helper descriptor ABI.
//!
//! The admission path deliberately stops at an in-memory lease. After that lease is held,
//! the fixed OpenStable transport may consume exactly one frame and write its response; neither
//! path alters a durable object or exposes a dispatch/spawn capability.

use crate::descriptor::{
    Descriptor, DescriptorContent, DescriptorError, DescriptorIdentity, DescriptorIdentityCommon,
    DescriptorKind, DescriptorPolicy,
};
use crate::persistence::PersistenceError;
use crate::stable::{
    self, PreparedActiveLease, PreverifiedHelperDigest, StableAdmissionError, StableVacantLease,
};
use crate::syscall::{
    self, Errno, O_LARGEFILE_STATUS, O_NONBLOCK_STATUS, O_RDONLY_ACCESS, O_RDWR_ACCESS,
    O_WRONLY_ACCESS, PidFd,
};
use crate::transport;
use std::fs::{self, File};
use std::mem;
use std::os::fd::{AsFd, AsRawFd, BorrowedFd};
use std::os::unix::fs::MetadataExt;

const HELPER_FD: i32 = 3;
const HOME_FD: i32 = 4;
const STATE_ROOT_FD: i32 = 5;
const NODE_FD: i32 = 6;
const SCRIPT_FD: i32 = 7;
const CONFIG_FD: i32 = 8;
const MAX_HELPER_SIZE: u64 = 33_554_432;
const MAX_NODE_SIZE: u64 = 134_217_728;
const MAX_SCRIPT_SIZE: u64 = 16_777_216;
const MAX_CONFIG_SIZE: u64 = 1_048_576;

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum InvocationError {
    Syscall(Errno),
    Descriptor(DescriptorError),
    ExtraDescriptor,
    MissingDescriptor,
    CloexecSet,
    InvalidStatusFlags,
    InvalidProtocolStream,
    AliasedDescriptors,
    HelperSelfMismatch,
    InvalidHelperElf,
    InvalidNodeElf,
    InvalidRuntimeScript,
    InvalidConfigSnapshot,
    InvalidHomeStateRelation,
    ParentProof,
    Replacement,
    Stable(StableAdmissionError),
}

/// The only externally observable pre-frame classifications.  `Unsupported` is deliberately
/// reserved for an explicit `ENOSYS` from a syscall required by this ABI; every other failure is
/// ambiguous and must be silent.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PreFrameResult {
    Admitted,
    Unsupported,
    Ambiguous,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OpenStableResult {
    Completed,
    Unsupported,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StreamClass {
    Pipe,
    UnixStream,
}

/// A descriptor-held identity for the kernel object backing a protocol stream.
///
/// `KCMP_FILE` distinguishes open file descriptions, but the read and write ends of one
/// anonymous pipe have different file descriptions while sharing this object identity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct StreamObjectIdentity {
    device: u64,
    inode: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ProtocolStream {
    class: StreamClass,
    object: StreamObjectIdentity,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct StrictIdentity {
    common: DescriptorIdentityCommon,
    link_count: u64,
    size: u64,
    digest: [u8; 32],
}

impl StrictIdentity {
    fn from_content(content: &DescriptorContent) -> Result<Self, InvocationError> {
        let DescriptorIdentity::StrictLeaf {
            common,
            link_count,
            size,
        } = content.identity
        else {
            return Err(InvocationError::Replacement);
        };
        Ok(Self {
            common,
            link_count,
            size,
            digest: content.digest,
        })
    }
}

/// Every descriptor-owned authority is revalidated after the only allowed descriptor mutation.
/// The values stay grouped so no identity can be omitted from the replacement boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct InvocationDescriptorIdentities {
    helper: StrictIdentity,
    home: DescriptorIdentityCommon,
    state_root: DescriptorIdentityCommon,
    node: StrictIdentity,
    script: StrictIdentity,
    config: StrictIdentity,
}

fn require_unchanged_identities_after_cloexec(
    before: InvocationDescriptorIdentities,
    after: InvocationDescriptorIdentities,
) -> Result<(), InvocationError> {
    if after != before {
        return Err(InvocationError::Replacement);
    }
    Ok(())
}

#[derive(Debug)]
struct ParentProof {
    _pidfd: PidFd,
    _executable: Descriptor,
}

/// Descriptor-held authority issued only after the FD 6 parent-executable observation has
/// linearized.  It is intentionally crate-private until a later protocol slice supplies framing.
#[derive(Debug)]
pub(crate) struct InvocationDescriptorLease {
    _helper: Descriptor,
    _home: Descriptor,
    state_root: Descriptor,
    _node: Descriptor,
    _script: Descriptor,
    _config: Descriptor,
    helper_digest: [u8; 32],
    _descriptor_set_digest: [u8; 32],
    _parent_proof: ParentProof,
}

/// The invocation and stable-vacant authorities are deliberately inseparable after binding.
#[derive(Debug)]
pub(crate) struct InvocationLease {
    _invocation: InvocationDescriptorLease,
    _stable: StableVacantLease,
}

/// The selected route's complete durable authority stays paired with the descriptor provenance
/// lease until transport has finished its one response write.
#[derive(Debug)]
struct RoutedInvocationLease {
    _invocation: InvocationDescriptorLease,
    _stable: Option<StableVacantLease>,
    _prepared: Option<PreparedActiveLease>,
}

struct InheritedAuthorities {
    helper: Descriptor,
    home: Descriptor,
    state_root: Descriptor,
    node: Descriptor,
    script: Descriptor,
    config: Descriptor,
}

impl InheritedAuthorities {
    /// # Safety
    ///
    /// The version-1 ABI reserves and transfers ownership of exactly these inherited descriptors.
    unsafe fn take() -> Self {
        Self {
            // SAFETY: the helper owns each fixed inherited descriptor until process exit.
            helper: unsafe { Descriptor::from_owned_raw_fd(HELPER_FD) },
            // SAFETY: the helper owns each fixed inherited descriptor until process exit.
            home: unsafe { Descriptor::from_owned_raw_fd(HOME_FD) },
            // SAFETY: the helper owns each fixed inherited descriptor until process exit.
            state_root: unsafe { Descriptor::from_owned_raw_fd(STATE_ROOT_FD) },
            // SAFETY: the helper owns each fixed inherited descriptor until process exit.
            node: unsafe { Descriptor::from_owned_raw_fd(NODE_FD) },
            // SAFETY: the helper owns each fixed inherited descriptor until process exit.
            script: unsafe { Descriptor::from_owned_raw_fd(SCRIPT_FD) },
            // SAFETY: the helper owns each fixed inherited descriptor until process exit.
            config: unsafe { Descriptor::from_owned_raw_fd(CONFIG_FD) },
        }
    }
}

/// Completes descriptor admission and then performs the existing read-only stable-vacant check.
/// Any failure before the in-memory descriptor lease exists intentionally leaks inherited handles:
/// the process exits immediately and must not normalize or close an unexpected caller handle.
pub(crate) fn admit_with_stable_lease() -> Result<InvocationLease, InvocationError> {
    let invocation = admit_descriptor_lease()?;
    admit_stable_after_router(invocation, || Ok(()))
}

fn require_route_capabilities(
    invocation: &InvocationDescriptorLease,
) -> Result<(), InvocationError> {
    // Compatibility detection is descriptor-scoped and occurs only after the exact inherited
    // invocation lease and router selection exist. Null paths keep it side-effect free.
    require_renameat2_flag(
        invocation.state_root.as_raw_fd(),
        syscall::PROBE_RENAME_NOREPLACE,
    )?;
    require_renameat2_flag(
        invocation.state_root.as_raw_fd(),
        syscall::PROBE_RENAME_EXCHANGE,
    )?;
    Ok(())
}

fn admit_stable_after_router(
    invocation: InvocationDescriptorLease,
    before_postcheck: impl FnOnce() -> Result<(), StableAdmissionError>,
) -> Result<InvocationLease, InvocationError> {
    require_route_capabilities(&invocation)?;
    let owner_uid = syscall::effective_uid().map_err(InvocationError::Syscall)?;
    let owner_gid = syscall::effective_gid().map_err(InvocationError::Syscall)?;
    let state_root = invocation
        .state_root
        .try_clone()
        .map_err(InvocationError::Descriptor)?;
    let stable = stable::admit_stable_vacant_with_postcheck(
        state_root,
        owner_uid,
        owner_gid,
        PreverifiedHelperDigest::new(invocation.helper_digest),
        before_postcheck,
    )
    .map_err(InvocationError::Stable)?;
    Ok(InvocationLease {
        _invocation: invocation,
        _stable: stable,
    })
}

fn admit_prepared_after_router(
    invocation: InvocationDescriptorLease,
    before_postcheck: impl FnOnce() -> Result<(), StableAdmissionError>,
) -> Result<RoutedInvocationLease, InvocationError> {
    require_route_capabilities(&invocation)?;
    let owner_uid = syscall::effective_uid().map_err(InvocationError::Syscall)?;
    let owner_gid = syscall::effective_gid().map_err(InvocationError::Syscall)?;
    let state_root = invocation
        .state_root
        .try_clone()
        .map_err(InvocationError::Descriptor)?;
    let prepared = stable::admit_prepared_active(
        state_root,
        owner_uid,
        owner_gid,
        PreverifiedHelperDigest::new(invocation.helper_digest),
        before_postcheck,
    )
    .map_err(InvocationError::Stable)?;
    Ok(RoutedInvocationLease {
        _invocation: invocation,
        _stable: None,
        _prepared: Some(prepared),
    })
}

/// Attempts the complete read-only invocation admission without exposing diagnostic detail.
pub fn admit() -> PreFrameResult {
    match admit_with_stable_lease() {
        Ok(_) => PreFrameResult::Admitted,
        Err(error) => classify_pre_frame_error(error),
    }
}

/// Retains descriptor provenance and the selected stable/Prepared lease while serving exactly one
/// bounded zero-session router handshake. No durable layout is inspected until FD 0 selected the
/// route, and fresh entropy is acquired only inside its final-admission callback.
pub fn serve_router() -> OpenStableResult {
    let invocation = match admit_descriptor_lease() {
        Ok(lease) => lease,
        Err(error) => {
            return match classify_pre_frame_error(error) {
                PreFrameResult::Unsupported => OpenStableResult::Unsupported,
                PreFrameResult::Admitted | PreFrameResult::Ambiguous => OpenStableResult::Failed,
            };
        }
    };
    let result = transport::serve_router(|request, gate| {
        let mut session_id = None;
        let entropy_before_final_postcheck = || {
            let fresh = gate
                .fresh_session_id()
                .map_err(StableAdmissionError::Transport)?;
            session_id = Some(fresh);
            Ok(())
        };
        let (lease, bytes) = match request.route {
            transport::RouterRoute::OpenStable => {
                let lease = admit_stable_after_router(invocation, entropy_before_final_postcheck)
                    .map_err(classify_router_admission_error)?;
                let session_id = session_id.ok_or(transport::TransportError::Entropy)?;
                let bytes = crate::protocol::open_stable_response(request.request_id, session_id)
                    .map_err(|_| transport::TransportError::Protocol)?;
                (
                    RoutedInvocationLease {
                        _invocation: lease._invocation,
                        _stable: Some(lease._stable),
                        _prepared: None,
                    },
                    bytes,
                )
            }
            transport::RouterRoute::ResumeActive => {
                let lease = admit_prepared_after_router(invocation, entropy_before_final_postcheck)
                    .map_err(classify_router_admission_error)?;
                let session_id = session_id.ok_or(transport::TransportError::Entropy)?;
                let bytes = crate::protocol::resume_active_response(request.request_id, session_id)
                    .map_err(|_| transport::TransportError::Protocol)?;
                (lease, bytes)
            }
        };
        Ok(transport::AdmittedResponse::new(bytes, lease))
    });
    match result {
        Ok(()) => OpenStableResult::Completed,
        Err(transport::TransportError::Unsupported) => OpenStableResult::Unsupported,
        Err(_) => OpenStableResult::Failed,
    }
}

fn classify_router_admission_error(error: InvocationError) -> transport::TransportError {
    if invocation_error_is_explicit_enosys(error) {
        transport::TransportError::Unsupported
    } else {
        // The router has not completed route admission, so this remains a silent outer refusal.
        transport::TransportError::Protocol
    }
}

fn classify_pre_frame_error(error: InvocationError) -> PreFrameResult {
    if invocation_error_is_explicit_enosys(error) {
        PreFrameResult::Unsupported
    } else {
        PreFrameResult::Ambiguous
    }
}

fn invocation_error_is_explicit_enosys(error: InvocationError) -> bool {
    match error {
        InvocationError::Syscall(errno) => errno == Errno::ENOSYS,
        InvocationError::Descriptor(error) => descriptor_error_is_explicit_enosys(error),
        InvocationError::Stable(error) => stable_error_is_explicit_enosys(error),
        _ => false,
    }
}

fn stable_error_is_explicit_enosys(error: StableAdmissionError) -> bool {
    match error {
        StableAdmissionError::Syscall(errno) => errno == Errno::ENOSYS,
        StableAdmissionError::Descriptor(error) => descriptor_error_is_explicit_enosys(error),
        StableAdmissionError::Persistence(error) => persistence_error_is_explicit_enosys(error),
        StableAdmissionError::Transport(transport::TransportError::Unsupported) => true,
        _ => false,
    }
}

fn persistence_error_is_explicit_enosys(error: PersistenceError) -> bool {
    match error {
        PersistenceError::Syscall(errno) => errno == Errno::ENOSYS,
        PersistenceError::Descriptor(error) | PersistenceError::MutationAmbiguous(error) => {
            descriptor_error_is_explicit_enosys(error)
        }
        _ => false,
    }
}

fn descriptor_error_is_explicit_enosys(error: DescriptorError) -> bool {
    matches!(error, DescriptorError::Io(errno) if errno == Errno::ENOSYS.0)
}

fn require_renameat2_flag(parent: i32, flag: usize) -> Result<(), InvocationError> {
    classify_renameat2_probe(syscall::probe_rename_flag_on_held_descriptor(parent, flag))
}

fn classify_renameat2_probe(result: Result<(), Errno>) -> Result<(), InvocationError> {
    match result {
        Err(Errno::EFAULT) => Ok(()),
        Err(error) => Err(InvocationError::Syscall(error)),
        Ok(()) => Err(InvocationError::Replacement),
    }
}

fn admit_descriptor_lease() -> Result<InvocationDescriptorLease, InvocationError> {
    verify_inherited_inventory()?;
    // SAFETY: inventory proved the fixed inherited ABI is present.  Any subsequent pre-lease
    // error intentionally forgets this owner so the process leaves caller descriptors untouched.
    let inherited = unsafe { InheritedAuthorities::take() };
    let admitted = (|| {
        validate_streams()?;
        validate_no_aliases()?;
        let owner_uid = syscall::effective_uid().map_err(InvocationError::Syscall)?;
        let owner_gid = syscall::effective_gid().map_err(InvocationError::Syscall)?;
        let helper = validate_helper(&inherited.helper, owner_uid, owner_gid)?;
        validate_helper_self(helper)?;
        let home = validate_home(&inherited.home, owner_uid)?;
        let state = validate_state_root(&inherited.state_root, owner_uid, owner_gid)?;
        validate_home_state_relation(&inherited.home, home, &inherited.state_root, state)?;
        let node = validate_node(&inherited.node)?;
        let script = validate_script(&inherited.script, owner_uid, owner_gid)?;
        let config = validate_config(&inherited.config, owner_uid, owner_gid)?;
        let identities = InvocationDescriptorIdentities {
            helper,
            home,
            state_root: state,
            node,
            script,
            config,
        };

        for descriptor in [
            HELPER_FD,
            HOME_FD,
            STATE_ROOT_FD,
            NODE_FD,
            SCRIPT_FD,
            CONFIG_FD,
        ] {
            syscall::set_descriptor_cloexec(descriptor).map_err(InvocationError::Syscall)?;
            if !syscall::descriptor_has_cloexec(descriptor).map_err(InvocationError::Syscall)? {
                return Err(InvocationError::CloexecSet);
            }
        }

        // Repeat every descriptor-owned authority after the only permitted descriptor mutation.
        let helper_after = validate_helper(&inherited.helper, owner_uid, owner_gid)?;
        validate_helper_self(helper_after)?;
        let home_after = validate_home(&inherited.home, owner_uid)?;
        let state_after = validate_state_root(&inherited.state_root, owner_uid, owner_gid)?;
        validate_home_state_relation(
            &inherited.home,
            home_after,
            &inherited.state_root,
            state_after,
        )?;
        let node_after = validate_node(&inherited.node)?;
        let script_after = validate_script(&inherited.script, owner_uid, owner_gid)?;
        let config_after = validate_config(&inherited.config, owner_uid, owner_gid)?;
        let identities_after = InvocationDescriptorIdentities {
            helper: helper_after,
            home: home_after,
            state_root: state_after,
            node: node_after,
            script: script_after,
            config: config_after,
        };
        require_unchanged_identities_after_cloexec(identities, identities_after)?;
        let descriptor_set_digest =
            invocation_descriptor_set_digest(helper, home, state, node, script, config);

        // This suffix is last: no fcntl, stable lock, output, frame read, or durable operation may
        // occur after this returns and before the in-memory lease is constructed below.
        let parent_proof = final_parent_proof(node)?;
        Ok((helper.digest, descriptor_set_digest, parent_proof))
    })();
    let (helper_digest, descriptor_set_digest, parent_proof) = match admitted {
        Ok(value) => value,
        Err(error) => {
            mem::forget(inherited);
            return Err(error);
        }
    };
    Ok(InvocationDescriptorLease {
        _helper: inherited.helper,
        _home: inherited.home,
        state_root: inherited.state_root,
        _node: inherited.node,
        _script: inherited.script,
        _config: inherited.config,
        helper_digest,
        _descriptor_set_digest: descriptor_set_digest,
        _parent_proof: parent_proof,
    })
}

fn verify_inherited_inventory() -> Result<(), InvocationError> {
    // Opening the fixed procfs directory consumes the lowest vacant FD.  It is the sole temporary
    // descriptor allowed during enumeration; every other entry numbered at least nine is caller
    // supplied ambiguity.
    let directory = File::open("/proc/self/fd").map_err(|_| InvocationError::MissingDescriptor)?;
    let enumeration_fd = directory.as_raw_fd();
    let entries =
        syscall::list_directory(directory.as_fd(), 64).map_err(InvocationError::Syscall)?;
    let seen = classify_inventory(entries.iter().map(Vec::as_slice), enumeration_fd)?;
    if seen.iter().any(|present| !present) {
        return Err(InvocationError::MissingDescriptor);
    }
    for descriptor in 0..=CONFIG_FD {
        if syscall::descriptor_has_cloexec(descriptor).map_err(InvocationError::Syscall)? {
            return Err(InvocationError::CloexecSet);
        }
    }
    Ok(())
}

fn classify_inventory<'a>(
    entries: impl IntoIterator<Item = &'a [u8]>,
    enumeration_fd: i32,
) -> Result<[bool; 9], InvocationError> {
    let mut seen = [false; 9];
    for entry in entries {
        let text = std::str::from_utf8(entry).map_err(|_| InvocationError::ExtraDescriptor)?;
        let descriptor = text
            .parse::<i32>()
            .map_err(|_| InvocationError::ExtraDescriptor)?;
        if descriptor == enumeration_fd {
            continue;
        }
        if !(0..=CONFIG_FD).contains(&descriptor) {
            return Err(InvocationError::ExtraDescriptor);
        }
        let index = usize::try_from(descriptor).map_err(|_| InvocationError::ExtraDescriptor)?;
        seen[index] = true;
    }
    Ok(seen)
}

fn validate_streams() -> Result<(), InvocationError> {
    let streams = [
        validate_stream(0, O_RDONLY_ACCESS)?,
        validate_stream(1, O_WRONLY_ACCESS)?,
        validate_stream(2, O_WRONLY_ACCESS)?,
    ];
    if streams
        .windows(2)
        .any(|pair| pair[0].class != pair[1].class)
    {
        return Err(InvocationError::InvalidProtocolStream);
    }
    require_distinct_stream_objects(streams)?;
    Ok(())
}

fn validate_stream(descriptor: i32, access: usize) -> Result<ProtocolStream, InvocationError> {
    let flags = syscall::descriptor_status_flags(descriptor).map_err(InvocationError::Syscall)?;
    validate_protocol_stream_status_flags(flags)?;
    let target = fs::read_link(format!("/proc/self/fd/{descriptor}"))
        .map_err(|_| InvocationError::InvalidProtocolStream)?;
    let target = target.as_os_str().as_encoded_bytes();
    if target.starts_with(b"pipe:[") && target.ends_with(b"]") {
        if flags & 3 != access {
            return Err(InvocationError::InvalidProtocolStream);
        }
        return Ok(ProtocolStream {
            // The procfs target is only the representation classifier.  Identity is bound below
            // from the held descriptor, never from this symlink target.
            class: StreamClass::Pipe,
            object: stream_object_identity(descriptor)?,
        });
    }
    if target.starts_with(b"socket:[")
        && target.ends_with(b"]")
        && flags & 3 == O_RDWR_ACCESS
        && syscall::is_connected_unnamed_unix_stream(descriptor)
            .map_err(InvocationError::Syscall)?
    {
        return Ok(ProtocolStream {
            class: StreamClass::UnixStream,
            object: stream_object_identity(descriptor)?,
        });
    }
    Err(InvocationError::InvalidProtocolStream)
}

/// Protocol I/O is deadline-bounded only when a readiness result cannot be followed by a
/// blocking operation.  This checks the caller-provided status flags but deliberately does not
/// normalize them: `O_NONBLOCK` belongs to the inherited open file description, so an `F_SETFL`
/// here could mutate a caller-visible authority after the ABI inventory was accepted.
fn validate_protocol_stream_status_flags(flags: usize) -> Result<(), InvocationError> {
    if flags & O_NONBLOCK_STATUS == 0 || flags & !(3 | O_NONBLOCK_STATUS | O_LARGEFILE_STATUS) != 0
    {
        return Err(InvocationError::InvalidStatusFlags);
    }
    Ok(())
}

fn stream_object_identity(descriptor: i32) -> Result<StreamObjectIdentity, InvocationError> {
    // SAFETY: descriptor admission owns the fixed inherited descriptor for this observation.
    // The owned clone makes `File::metadata` an fstat of that held object, not a pathname lookup.
    let held = unsafe { BorrowedFd::borrow_raw(descriptor) }
        .try_clone_to_owned()
        .map_err(|error| {
            InvocationError::Descriptor(DescriptorError::Io(error.raw_os_error().unwrap_or(5)))
        })?;
    let metadata = File::from(held).metadata().map_err(|error| {
        InvocationError::Descriptor(DescriptorError::Io(error.raw_os_error().unwrap_or(5)))
    })?;
    Ok(StreamObjectIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

fn require_distinct_stream_objects(streams: [ProtocolStream; 3]) -> Result<(), InvocationError> {
    for first in 0..streams.len() {
        for second in first + 1..streams.len() {
            if streams[first].object == streams[second].object {
                return Err(InvocationError::InvalidProtocolStream);
            }
        }
    }
    Ok(())
}

fn validate_no_aliases() -> Result<(), InvocationError> {
    for first in 0..=CONFIG_FD {
        for second in first + 1..=CONFIG_FD {
            if syscall::same_file_description(first, second).map_err(InvocationError::Syscall)? {
                return Err(InvocationError::AliasedDescriptors);
            }
        }
    }
    Ok(())
}

fn exact_regular_policy(owner_uid: u32, owner_gid: u32, max_size: u64) -> DescriptorPolicy {
    DescriptorPolicy {
        kind: DescriptorKind::RegularFile,
        owner_uid,
        owner_gid,
        exact_mode: 0o755,
        require_single_link: true,
        max_size: Some(max_size),
    }
}

fn validate_regular_status(descriptor: &Descriptor) -> Result<(), InvocationError> {
    let flags = syscall::descriptor_status_flags(descriptor.as_raw_fd())
        .map_err(InvocationError::Syscall)?;
    if flags & 3 != O_RDONLY_ACCESS || flags & !(3 | O_LARGEFILE_STATUS) != 0 {
        return Err(InvocationError::InvalidStatusFlags);
    }
    Ok(())
}

fn validate_helper(
    descriptor: &Descriptor,
    effective_uid: u32,
    effective_gid: u32,
) -> Result<StrictIdentity, InvocationError> {
    validate_regular_status(descriptor)?;
    let metadata = descriptor.as_fd().try_clone_to_owned().map_err(|error| {
        InvocationError::Descriptor(DescriptorError::Io(error.raw_os_error().unwrap_or(5)))
    })?;
    let metadata = File::from(metadata).metadata().map_err(|error| {
        InvocationError::Descriptor(DescriptorError::Io(error.raw_os_error().unwrap_or(5)))
    })?;
    let owner_is_allowed = (metadata.uid() == 0 && metadata.gid() == 0)
        || (metadata.uid() == effective_uid && metadata.gid() == effective_gid);
    if !owner_is_allowed {
        return Err(InvocationError::Descriptor(DescriptorError::WrongOwner));
    }
    let content = descriptor
        .read_complete(exact_regular_policy(
            metadata.uid(),
            metadata.gid(),
            MAX_HELPER_SIZE,
        ))
        .map_err(InvocationError::Descriptor)?;
    let identity = StrictIdentity::from_content(&content)?;
    if !(1..=MAX_HELPER_SIZE).contains(&identity.size) || !is_static_helper_elf(&content.bytes) {
        return Err(InvocationError::InvalidHelperElf);
    }
    Ok(identity)
}

fn validate_helper_self(expected: StrictIdentity) -> Result<(), InvocationError> {
    let self_image = Descriptor::from_file(
        File::open("/proc/self/exe").map_err(|_| InvocationError::HelperSelfMismatch)?,
    );
    let metadata = self_image
        .as_fd()
        .try_clone_to_owned()
        .map_err(|_| InvocationError::HelperSelfMismatch)?;
    let metadata = File::from(metadata)
        .metadata()
        .map_err(|_| InvocationError::HelperSelfMismatch)?;
    let policy = exact_regular_policy(metadata.uid(), metadata.gid(), MAX_HELPER_SIZE);
    let observed = self_image
        .read_complete(policy)
        .map_err(|_| InvocationError::HelperSelfMismatch)?;
    if StrictIdentity::from_content(&observed)? != expected {
        return Err(InvocationError::HelperSelfMismatch);
    }
    Ok(())
}

fn validate_home(
    descriptor: &Descriptor,
    effective_uid: u32,
) -> Result<DescriptorIdentityCommon, InvocationError> {
    validate_regular_or_directory_status(descriptor)?;
    let metadata = metadata_for(descriptor)?;
    if metadata.mode() & 0o170000 != 0o040000 {
        return Err(InvocationError::Descriptor(DescriptorError::WrongKind));
    }
    if metadata.uid() != effective_uid {
        return Err(InvocationError::Descriptor(DescriptorError::WrongOwner));
    }
    if metadata.mode() & 0o022 != 0 {
        return Err(InvocationError::Descriptor(DescriptorError::WrongMode));
    }
    match descriptor
        .validate(DescriptorPolicy {
            kind: DescriptorKind::Directory,
            owner_uid: effective_uid,
            owner_gid: metadata.gid(),
            exact_mode: metadata.mode() & 0o7777,
            require_single_link: false,
            max_size: None,
        })
        .map_err(InvocationError::Descriptor)?
    {
        DescriptorIdentity::StableDirectory(identity) => Ok(identity),
        DescriptorIdentity::StrictLeaf { .. } => Err(InvocationError::Replacement),
    }
}

fn validate_state_root(
    descriptor: &Descriptor,
    effective_uid: u32,
    effective_gid: u32,
) -> Result<DescriptorIdentityCommon, InvocationError> {
    validate_regular_or_directory_status(descriptor)?;
    match descriptor
        .validate(DescriptorPolicy {
            kind: DescriptorKind::Directory,
            owner_uid: effective_uid,
            owner_gid: effective_gid,
            exact_mode: 0o700,
            require_single_link: false,
            max_size: None,
        })
        .map_err(InvocationError::Descriptor)?
    {
        DescriptorIdentity::StableDirectory(identity) => Ok(identity),
        DescriptorIdentity::StrictLeaf { .. } => Err(InvocationError::Replacement),
    }
}

fn validate_regular_or_directory_status(descriptor: &Descriptor) -> Result<(), InvocationError> {
    let flags = syscall::descriptor_status_flags(descriptor.as_raw_fd())
        .map_err(InvocationError::Syscall)?;
    if flags & 3 != O_RDONLY_ACCESS || flags & !(3 | O_NONBLOCK_STATUS | O_LARGEFILE_STATUS) != 0 {
        return Err(InvocationError::InvalidStatusFlags);
    }
    Ok(())
}

fn validate_home_state_relation(
    home: &Descriptor,
    expected_home: DescriptorIdentityCommon,
    state_root: &Descriptor,
    expected_state_root: DescriptorIdentityCommon,
) -> Result<(), InvocationError> {
    for _ in 0..2 {
        if validate_home(home, expected_home.uid)? != expected_home
            || validate_state_root(state_root, expected_state_root.uid, expected_state_root.gid)?
                != expected_state_root
        {
            return Err(InvocationError::Replacement);
        }
        let resolved = syscall::open_beneath(
            home.as_fd(),
            c".lcm",
            syscall::OpenAccess::ReadOnly { directory: true },
        )
        .map_err(InvocationError::Syscall)?;
        let resolved_identity =
            validate_state_root(&resolved, expected_state_root.uid, expected_state_root.gid)?;
        if resolved_identity != expected_state_root {
            return Err(InvocationError::InvalidHomeStateRelation);
        }
    }
    Ok(())
}

fn validate_node(descriptor: &Descriptor) -> Result<StrictIdentity, InvocationError> {
    validate_regular_status(descriptor)?;
    let metadata = metadata_for(descriptor)?;
    let content = descriptor
        .read_complete(exact_regular_policy(
            metadata.uid(),
            metadata.gid(),
            MAX_NODE_SIZE,
        ))
        .map_err(InvocationError::Descriptor)?;
    let identity = StrictIdentity::from_content(&content)?;
    if !(64..=MAX_NODE_SIZE).contains(&identity.size) || !is_node_elf(&content.bytes) {
        return Err(InvocationError::InvalidNodeElf);
    }
    Ok(identity)
}

fn validate_script(
    descriptor: &Descriptor,
    effective_uid: u32,
    effective_gid: u32,
) -> Result<StrictIdentity, InvocationError> {
    validate_regular_status(descriptor)?;
    let metadata = metadata_for(descriptor)?;
    let allowed_owner = (metadata.uid() == 0 && metadata.gid() == 0)
        || (metadata.uid() == effective_uid && metadata.gid() == effective_gid);
    if !allowed_owner {
        return Err(InvocationError::Descriptor(DescriptorError::WrongOwner));
    }
    let content = descriptor
        .read_complete(exact_regular_policy(
            metadata.uid(),
            metadata.gid(),
            MAX_SCRIPT_SIZE,
        ))
        .map_err(InvocationError::Descriptor)?;
    let identity = StrictIdentity::from_content(&content)?;
    if !(20..=MAX_SCRIPT_SIZE).contains(&identity.size)
        || !content.bytes.starts_with(b"#!/usr/bin/env node\n")
        || content.bytes.contains(&0)
        || std::str::from_utf8(&content.bytes).is_err()
    {
        return Err(InvocationError::InvalidRuntimeScript);
    }
    Ok(identity)
}

fn validate_config(
    descriptor: &Descriptor,
    effective_uid: u32,
    effective_gid: u32,
) -> Result<StrictIdentity, InvocationError> {
    validate_regular_status(descriptor)?;
    let content = descriptor
        .read_complete(
            exact_regular_policy(effective_uid, effective_gid, MAX_CONFIG_SIZE).with_mode(0o600),
        )
        .map_err(InvocationError::Descriptor)?;
    let identity = StrictIdentity::from_content(&content)?;
    if !(1..=MAX_CONFIG_SIZE).contains(&identity.size)
        || content.bytes.contains(&0)
        || !is_exact_json_object(&content.bytes)
    {
        return Err(InvocationError::InvalidConfigSnapshot);
    }
    Ok(identity)
}

trait PolicyMode {
    fn with_mode(self, mode: u32) -> Self;
}

impl PolicyMode for DescriptorPolicy {
    fn with_mode(mut self, mode: u32) -> Self {
        self.exact_mode = mode;
        self
    }
}

fn metadata_for(descriptor: &Descriptor) -> Result<fs::Metadata, InvocationError> {
    descriptor
        .as_fd()
        .try_clone_to_owned()
        .map_err(|error| {
            InvocationError::Descriptor(DescriptorError::Io(error.raw_os_error().unwrap_or(5)))
        })
        .and_then(|owned| {
            File::from(owned).metadata().map_err(|error| {
                InvocationError::Descriptor(DescriptorError::Io(error.raw_os_error().unwrap_or(5)))
            })
        })
}

fn final_parent_proof(expected_node: StrictIdentity) -> Result<ParentProof, InvocationError> {
    let parent = syscall::direct_parent_pid().map_err(InvocationError::Syscall)?;
    if parent == 0 {
        return Err(InvocationError::ParentProof);
    }
    syscall::arm_parent_death_sigkill().map_err(InvocationError::Syscall)?;
    if syscall::direct_parent_pid().map_err(InvocationError::Syscall)? != parent {
        return Err(InvocationError::ParentProof);
    }
    let pidfd = PidFd::open(parent).map_err(InvocationError::Syscall)?;
    let before_start = parent_start_time(parent)?;
    ensure_parent_tuple(parent, &pidfd, before_start)?;

    let executable = Descriptor::from_file(
        File::open(format!("/proc/{parent}/exe")).map_err(|_| InvocationError::ParentProof)?,
    );
    let observed = validate_node(&executable)?;
    if observed != expected_node {
        return Err(InvocationError::ParentProof);
    }
    ensure_parent_tuple(parent, &pidfd, before_start)?;
    Ok(ParentProof {
        _pidfd: pidfd,
        _executable: executable,
    })
}

/// The final suffix's observable contract, factored from its Linux descriptor implementation so
/// every race boundary can be exercised without changing a test runner's parent or namespace.
#[cfg(test)]
trait ParentProofBackend {
    fn direct_parent(&mut self) -> Result<u32, InvocationError>;
    fn arm_pdeathsig(&mut self) -> Result<(), InvocationError>;
    fn pidfd_open(&mut self, parent: u32) -> Result<(), InvocationError>;
    fn start_time(&mut self, parent: u32) -> Result<u64, InvocationError>;
    fn same_namespace(&mut self, parent: u32) -> Result<bool, InvocationError>;
    fn pidfd_live(&mut self) -> Result<(), InvocationError>;
    fn fresh_executable(&mut self, parent: u32) -> Result<StrictIdentity, InvocationError>;
    fn issued(&mut self);
}

#[cfg(test)]
fn final_parent_proof_sequence(
    backend: &mut impl ParentProofBackend,
    expected_node: StrictIdentity,
) -> Result<(), InvocationError> {
    let parent = backend.direct_parent()?;
    if parent == 0 {
        return Err(InvocationError::ParentProof);
    }
    backend.arm_pdeathsig()?;
    if backend.direct_parent()? != parent {
        return Err(InvocationError::ParentProof);
    }
    backend.pidfd_open(parent)?;
    let start = backend.start_time(parent)?;
    validate_parent_tuple(backend, parent, start)?;
    if backend.fresh_executable(parent)? != expected_node {
        return Err(InvocationError::ParentProof);
    }
    validate_parent_tuple(backend, parent, start)?;
    // This is intentionally the final callback: it represents LeaseIssued, with no cleanup or
    // externally visible action sequenced between the final tuple and the result.
    backend.issued();
    Ok(())
}

#[cfg(test)]
fn validate_parent_tuple(
    backend: &mut impl ParentProofBackend,
    parent: u32,
    start: u64,
) -> Result<(), InvocationError> {
    if backend.direct_parent()? != parent
        || backend.start_time(parent)? != start
        || !backend.same_namespace(parent)?
    {
        return Err(InvocationError::ParentProof);
    }
    backend.pidfd_live()
}

fn ensure_parent_tuple(
    parent: u32,
    pidfd: &PidFd,
    expected_start: u64,
) -> Result<(), InvocationError> {
    if syscall::direct_parent_pid().map_err(InvocationError::Syscall)? != parent
        || parent_start_time(parent)? != expected_start
        || !same_pid_namespace(parent)?
    {
        return Err(InvocationError::ParentProof);
    }
    syscall::pidfd_is_live(pidfd.descriptor().as_raw_fd()).map_err(InvocationError::Syscall)
}

fn same_pid_namespace(parent: u32) -> Result<bool, InvocationError> {
    let self_ns = fs::metadata("/proc/self/ns/pid").map_err(|_| InvocationError::ParentProof)?;
    let parent_ns =
        fs::metadata(format!("/proc/{parent}/ns/pid")).map_err(|_| InvocationError::ParentProof)?;
    Ok(self_ns.dev() == parent_ns.dev() && self_ns.ino() == parent_ns.ino())
}

fn parent_start_time(parent: u32) -> Result<u64, InvocationError> {
    let bytes =
        fs::read(format!("/proc/{parent}/stat")).map_err(|_| InvocationError::ParentProof)?;
    if bytes.len() > 4096 {
        return Err(InvocationError::ParentProof);
    }
    let close = bytes
        .iter()
        .rposition(|byte| *byte == b')')
        .ok_or(InvocationError::ParentProof)?;
    let rest = bytes.get(close + 2..).ok_or(InvocationError::ParentProof)?;
    let field = rest
        .split(|byte| *byte == b' ')
        .nth(19)
        .ok_or(InvocationError::ParentProof)?;
    parse_decimal(field).ok_or(InvocationError::ParentProof)
}

fn parse_decimal(bytes: &[u8]) -> Option<u64> {
    if bytes.is_empty() || bytes.iter().any(|byte| !byte.is_ascii_digit()) {
        return None;
    }
    let mut value = 0_u64;
    for byte in bytes {
        value = value.checked_mul(10)?.checked_add(u64::from(byte - b'0'))?;
    }
    Some(value)
}

fn invocation_descriptor_set_digest(
    helper: StrictIdentity,
    home: DescriptorIdentityCommon,
    state_root: DescriptorIdentityCommon,
    node: StrictIdentity,
    script: StrictIdentity,
    config: StrictIdentity,
) -> [u8; 32] {
    let mut body = Vec::with_capacity(456);
    body.extend_from_slice(b"LCMI");
    body.extend_from_slice(&1_u16.to_le_bytes());
    body.extend_from_slice(&6_u16.to_le_bytes());
    append_regular_entry(&mut body, HELPER_FD as u8, 1, helper);
    append_directory_entry(&mut body, HOME_FD as u8, 2, home);
    append_directory_entry(&mut body, STATE_ROOT_FD as u8, 3, state_root);
    append_regular_entry(&mut body, NODE_FD as u8, 4, node);
    append_regular_entry(&mut body, SCRIPT_FD as u8, 5, script);
    append_regular_entry(&mut body, CONFIG_FD as u8, 6, config);
    body.extend_from_slice(&[
        0xdf, 0xc1, 0x3f, 0x98, 0x9a, 0x5a, 0xdc, 0x19, 0xba, 0x13, 0xf7, 0xdf, 0x0e, 0xb0, 0x90,
        0x08, 0xa0, 0x60, 0x54, 0x4e, 0x62, 0x18, 0x69, 0xf7, 0x08, 0x37, 0x76, 0x10, 0x69, 0x2c,
        0xc5, 0xa,
    ]);
    body.extend_from_slice(&[
        0xcf, 0x87, 0x00, 0xf1, 0x39, 0x84, 0x7b, 0x30, 0xce, 0xa0, 0xb9, 0xdc, 0xc5, 0x17, 0xcd,
        0x51, 0x55, 0x6f, 0xaa, 0xd0, 0x52, 0x47, 0x91, 0x2c, 0x6e, 0x8b, 0x09, 0x8f, 0xc9, 0x97,
        0x37, 0x50,
    ]);
    debug_assert_eq!(body.len(), 456);
    let mut domain = b"LCMR/INVOCATION-DESCRIPTORS/v1".to_vec();
    domain.extend_from_slice(&body);
    crate::sha256::digest(&domain)
}

fn append_common_entry(
    body: &mut Vec<u8>,
    descriptor: u8,
    role: u8,
    kind: u8,
    common: DescriptorIdentityCommon,
) {
    body.extend_from_slice(&[descriptor, role, kind, 0]);
    body.extend_from_slice(&common.device.to_le_bytes());
    body.extend_from_slice(&common.inode.to_le_bytes());
    body.extend_from_slice(&common.uid.to_le_bytes());
    body.extend_from_slice(&common.gid.to_le_bytes());
    body.extend_from_slice(&common.mode.to_le_bytes());
}

fn append_directory_entry(
    body: &mut Vec<u8>,
    descriptor: u8,
    role: u8,
    common: DescriptorIdentityCommon,
) {
    append_common_entry(body, descriptor, role, 1, common);
}

fn append_regular_entry(body: &mut Vec<u8>, descriptor: u8, role: u8, identity: StrictIdentity) {
    append_common_entry(body, descriptor, role, 2, identity.common);
    body.extend_from_slice(&identity.link_count.to_le_bytes());
    body.extend_from_slice(&identity.size.to_le_bytes());
    body.extend_from_slice(&identity.digest);
}

fn is_static_helper_elf(bytes: &[u8]) -> bool {
    matches!(elf_type(bytes), Some(2 | 3)) && elf_has_no_interp_or_needed(bytes)
}

fn is_node_elf(bytes: &[u8]) -> bool {
    matches!(elf_type(bytes), Some(2)) && elf_program_headers(bytes).is_some()
}

fn elf_type(bytes: &[u8]) -> Option<u16> {
    if bytes.get(..7)? != b"\x7fELF\x02\x01\x01" || bytes.len() < 64 {
        return None;
    }
    if le_u16(bytes, 18)? != 62 {
        return None;
    }
    le_u16(bytes, 16)
}

fn elf_program_headers(bytes: &[u8]) -> Option<Vec<&[u8]>> {
    elf_type(bytes)?;
    let offset = usize::try_from(le_u64(bytes, 32)?).ok()?;
    let entry_size = usize::from(le_u16(bytes, 54)?);
    let count = usize::from(le_u16(bytes, 56)?);
    if entry_size != 56 || count > 1024 {
        return None;
    }
    let end = offset.checked_add(entry_size.checked_mul(count)?)?;
    let table = bytes.get(offset..end)?;
    Some(table.chunks_exact(56).collect())
}

fn elf_has_no_interp_or_needed(bytes: &[u8]) -> bool {
    let Some(headers) = elf_program_headers(bytes) else {
        return false;
    };
    for header in headers {
        match le_u32(header, 0) {
            Some(3) => return false,
            Some(2) => {
                let Some(offset) = le_u64(header, 8).and_then(|value| usize::try_from(value).ok())
                else {
                    return false;
                };
                let Some(size) = le_u64(header, 32).and_then(|value| usize::try_from(value).ok())
                else {
                    return false;
                };
                let Some(end) = offset.checked_add(size) else {
                    return false;
                };
                let Some(entries) = bytes.get(offset..end) else {
                    return false;
                };
                if entries.len() % 16 != 0
                    || entries
                        .chunks_exact(16)
                        .any(|entry| le_u64(entry, 0) == Some(1))
                {
                    return false;
                }
            }
            _ => {}
        }
    }
    true
}

fn le_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes(
        bytes.get(offset..offset + 2)?.try_into().ok()?,
    ))
}

fn le_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn le_u64(bytes: &[u8], offset: usize) -> Option<u64> {
    Some(u64::from_le_bytes(
        bytes.get(offset..offset + 8)?.try_into().ok()?,
    ))
}

fn is_exact_json_object(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    let mut parser = JsonParser {
        bytes: text.as_bytes(),
        index: 0,
    };
    parser.skip_space();
    if !parser.object(0) {
        return false;
    }
    parser.skip_space();
    parser.index == parser.bytes.len()
}

struct JsonParser<'a> {
    bytes: &'a [u8],
    index: usize,
}

impl JsonParser<'_> {
    fn skip_space(&mut self) {
        while matches!(
            self.bytes.get(self.index),
            Some(b' ' | b'\n' | b'\r' | b'\t')
        ) {
            self.index += 1;
        }
    }

    fn object(&mut self, depth: u8) -> bool {
        if depth > 64 || !self.take(b'{') {
            return false;
        }
        self.skip_space();
        if self.take(b'}') {
            return true;
        }
        loop {
            if !self.string() {
                return false;
            }
            self.skip_space();
            if !self.take(b':') || !self.value(depth + 1) {
                return false;
            }
            self.skip_space();
            if self.take(b'}') {
                return true;
            }
            if !self.take(b',') {
                return false;
            }
            self.skip_space();
        }
    }

    fn array(&mut self, depth: u8) -> bool {
        if depth > 64 || !self.take(b'[') {
            return false;
        }
        self.skip_space();
        if self.take(b']') {
            return true;
        }
        loop {
            if !self.value(depth + 1) {
                return false;
            }
            self.skip_space();
            if self.take(b']') {
                return true;
            }
            if !self.take(b',') {
                return false;
            }
            self.skip_space();
        }
    }

    fn value(&mut self, depth: u8) -> bool {
        self.skip_space();
        match self.bytes.get(self.index) {
            Some(b'{') => self.object(depth),
            Some(b'[') => self.array(depth),
            Some(b'"') => self.string(),
            Some(b'-' | b'0'..=b'9') => self.number(),
            Some(b't') => self.literal(b"true"),
            Some(b'f') => self.literal(b"false"),
            Some(b'n') => self.literal(b"null"),
            _ => false,
        }
    }

    fn string(&mut self) -> bool {
        if !self.take(b'"') {
            return false;
        }
        while let Some(byte) = self.bytes.get(self.index).copied() {
            self.index += 1;
            match byte {
                b'"' => return true,
                0..=0x1f => return false,
                b'\\' => match self.bytes.get(self.index).copied() {
                    Some(b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't') => self.index += 1,
                    Some(b'u') => {
                        self.index += 1;
                        if self
                            .bytes
                            .get(self.index..self.index + 4)
                            .is_none_or(|hex| !hex.iter().all(u8::is_ascii_hexdigit))
                        {
                            return false;
                        }
                        self.index += 4;
                    }
                    _ => return false,
                },
                _ => {}
            }
        }
        false
    }

    fn number(&mut self) -> bool {
        self.take(b'-');
        match self.bytes.get(self.index) {
            Some(b'0') => self.index += 1,
            Some(b'1'..=b'9') => {
                while matches!(self.bytes.get(self.index), Some(b'0'..=b'9')) {
                    self.index += 1;
                }
            }
            _ => return false,
        }
        if self.take(b'.') && !self.take_digits() {
            return false;
        }
        if matches!(self.bytes.get(self.index), Some(b'e' | b'E')) {
            self.index += 1;
            self.take(b'+');
            self.take(b'-');
            if !self.take_digits() {
                return false;
            }
        }
        true
    }

    fn take_digits(&mut self) -> bool {
        let start = self.index;
        while matches!(self.bytes.get(self.index), Some(b'0'..=b'9')) {
            self.index += 1;
        }
        self.index != start
    }

    fn literal(&mut self, literal: &[u8]) -> bool {
        if self.bytes.get(self.index..self.index + literal.len()) == Some(literal) {
            self.index += literal.len();
            true
        } else {
            false
        }
    }

    fn take(&mut self, expected: u8) -> bool {
        if self.bytes.get(self.index) == Some(&expected) {
            self.index += 1;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::FromRawFd;

    unsafe extern "C" {
        fn pipe2(pipefd: *mut i32, flags: i32) -> i32;
    }

    fn nonblocking_pipe() -> (File, File) {
        let mut descriptors = [-1_i32; 2];
        // SAFETY: `descriptors` is writable for exactly the two file descriptors required by
        // pipe2, and O_NONBLOCK is the status supplied by the external ABI caller.
        assert_eq!(
            unsafe { pipe2(descriptors.as_mut_ptr(), O_NONBLOCK_STATUS as i32) },
            0
        );
        // SAFETY: successful pipe2 returned two fresh owned descriptors.
        unsafe {
            (
                File::from_raw_fd(descriptors[0]),
                File::from_raw_fd(descriptors[1]),
            )
        }
    }

    fn strict(seed: u64) -> StrictIdentity {
        StrictIdentity {
            common: DescriptorIdentityCommon {
                device: seed,
                inode: seed + 1,
                uid: 99,
                gid: 77,
                mode: 0o755,
            },
            link_count: 1,
            size: 64,
            digest: [seed as u8; 32],
        }
    }

    struct FakeParent {
        calls: usize,
        fail_at: Option<usize>,
        executable: StrictIdentity,
        issued: bool,
    }

    impl FakeParent {
        fn touch(&mut self) -> Result<(), InvocationError> {
            self.calls += 1;
            if self.fail_at == Some(self.calls) {
                return Err(InvocationError::ParentProof);
            }
            Ok(())
        }
    }

    impl ParentProofBackend for FakeParent {
        fn direct_parent(&mut self) -> Result<u32, InvocationError> {
            self.touch()?;
            Ok(4321)
        }
        fn arm_pdeathsig(&mut self) -> Result<(), InvocationError> {
            self.touch()
        }
        fn pidfd_open(&mut self, _parent: u32) -> Result<(), InvocationError> {
            self.touch()
        }
        fn start_time(&mut self, _parent: u32) -> Result<u64, InvocationError> {
            self.touch()?;
            Ok(123)
        }
        fn same_namespace(&mut self, _parent: u32) -> Result<bool, InvocationError> {
            self.touch()?;
            Ok(true)
        }
        fn pidfd_live(&mut self) -> Result<(), InvocationError> {
            self.touch()
        }
        fn fresh_executable(&mut self, _parent: u32) -> Result<StrictIdentity, InvocationError> {
            self.touch()?;
            Ok(self.executable)
        }
        fn issued(&mut self) {
            self.calls += 1;
            self.issued = true;
        }
    }

    fn elf(kind: u16) -> Vec<u8> {
        let mut bytes = vec![0_u8; 120];
        bytes[..7].copy_from_slice(b"\x7fELF\x02\x01\x01");
        bytes[16..18].copy_from_slice(&kind.to_le_bytes());
        bytes[18..20].copy_from_slice(&62_u16.to_le_bytes());
        bytes[32..40].copy_from_slice(&64_u64.to_le_bytes());
        bytes[54..56].copy_from_slice(&56_u16.to_le_bytes());
        bytes[56..58].copy_from_slice(&1_u16.to_le_bytes());
        bytes
    }

    #[test]
    fn elf_policy_accepts_static_exec_and_static_pie_only() {
        assert!(is_static_helper_elf(&elf(2)));
        assert!(is_static_helper_elf(&elf(3)));
        assert!(is_node_elf(&elf(2)));
        assert!(!is_node_elf(&elf(3)));

        let mut interpreter = elf(3);
        interpreter[64..68].copy_from_slice(&3_u32.to_le_bytes());
        assert!(!is_static_helper_elf(&interpreter));

        let mut needed = elf(3);
        needed[64..68].copy_from_slice(&2_u32.to_le_bytes());
        needed[72..80].copy_from_slice(&120_u64.to_le_bytes());
        needed[96..104].copy_from_slice(&16_u64.to_le_bytes());
        needed.resize(136, 0);
        needed[120..128].copy_from_slice(&1_u64.to_le_bytes());
        assert!(!is_static_helper_elf(&needed));
    }

    #[test]
    fn snapshot_requires_one_complete_json_object() {
        for accepted in [
            br#"{}"#.as_slice(),
            b" { \"a\": [true, null, -1.2e+3]} \n".as_slice(),
        ] {
            assert!(is_exact_json_object(accepted));
        }
        for rejected in [
            br#"[]"#.as_slice(),
            br#"{}{}"#.as_slice(),
            br#"{\"a\":}"#.as_slice(),
            b"{\"a\":\"\x00\"}".as_slice(),
        ] {
            assert!(!is_exact_json_object(rejected));
        }
    }

    #[test]
    fn proc_start_time_parser_uses_the_parenthesized_comm_boundary() {
        assert_eq!(parse_decimal(b"123"), Some(123));
        assert_eq!(parse_decimal(b"12x"), None);
        let stat =
            b"77 (name with ) punctuation) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 987";
        let close = stat.iter().rposition(|byte| *byte == b')').unwrap();
        assert_eq!(
            parse_decimal(
                stat[close + 2..]
                    .split(|byte| *byte == b' ')
                    .nth(19)
                    .unwrap()
            ),
            Some(987)
        );
    }

    #[test]
    fn inventory_requires_exactly_the_fixed_nine_descriptors() {
        let exact: Vec<_> = (0..=8)
            .map(|number| number.to_string().into_bytes())
            .collect();
        assert_eq!(
            classify_inventory(exact.iter().map(Vec::as_slice), 9).unwrap(),
            [true; 9]
        );
        let missing: Vec<_> = (0..=7)
            .map(|number| number.to_string().into_bytes())
            .collect();
        assert_ne!(
            classify_inventory(missing.iter().map(Vec::as_slice), 9).unwrap(),
            [true; 9]
        );
        let mut extra = exact;
        extra.push(b"9".to_vec());
        assert_eq!(
            classify_inventory(extra.iter().map(Vec::as_slice), 10),
            Err(InvocationError::ExtraDescriptor)
        );
    }

    #[test]
    fn protocol_streams_reject_opposite_ends_of_one_anonymous_pipe() {
        let (request_reader, response_writer) = std::io::pipe().unwrap();
        let (_diagnostic_reader, diagnostic_writer) = std::io::pipe().unwrap();
        let streams = [
            ProtocolStream {
                class: StreamClass::Pipe,
                object: stream_object_identity(request_reader.as_raw_fd()).unwrap(),
            },
            ProtocolStream {
                class: StreamClass::Pipe,
                object: stream_object_identity(response_writer.as_raw_fd()).unwrap(),
            },
            ProtocolStream {
                class: StreamClass::Pipe,
                object: stream_object_identity(diagnostic_writer.as_raw_fd()).unwrap(),
            },
        ];

        assert_eq!(streams[0].object, streams[1].object);
        assert_eq!(
            require_distinct_stream_objects(streams),
            Err(InvocationError::InvalidProtocolStream)
        );
    }

    #[test]
    fn protocol_streams_accept_distinct_pipe_and_unix_stream_objects() {
        let (request_reader, _request_writer) = std::io::pipe().unwrap();
        let (_response_reader, response_writer) = std::io::pipe().unwrap();
        let (_diagnostic_reader, diagnostic_writer) = std::io::pipe().unwrap();
        let distinct_pipes = [
            ProtocolStream {
                class: StreamClass::Pipe,
                object: stream_object_identity(request_reader.as_raw_fd()).unwrap(),
            },
            ProtocolStream {
                class: StreamClass::Pipe,
                object: stream_object_identity(response_writer.as_raw_fd()).unwrap(),
            },
            ProtocolStream {
                class: StreamClass::Pipe,
                object: stream_object_identity(diagnostic_writer.as_raw_fd()).unwrap(),
            },
        ];
        assert!(require_distinct_stream_objects(distinct_pipes).is_ok());

        let (request, _request_peer) = std::os::unix::net::UnixStream::pair().unwrap();
        let (response, _response_peer) = std::os::unix::net::UnixStream::pair().unwrap();
        let (diagnostic, _diagnostic_peer) = std::os::unix::net::UnixStream::pair().unwrap();
        let distinct_unix_streams = [
            ProtocolStream {
                class: StreamClass::UnixStream,
                object: stream_object_identity(request.as_raw_fd()).unwrap(),
            },
            ProtocolStream {
                class: StreamClass::UnixStream,
                object: stream_object_identity(response.as_raw_fd()).unwrap(),
            },
            ProtocolStream {
                class: StreamClass::UnixStream,
                object: stream_object_identity(diagnostic.as_raw_fd()).unwrap(),
            },
        ];
        assert!(require_distinct_stream_objects(distinct_unix_streams).is_ok());
    }

    #[test]
    fn protocol_streams_reject_blocking_status_without_mutating_inherited_fd() {
        let (reader, _writer) = std::io::pipe().unwrap();
        let before = syscall::descriptor_status_flags(reader.as_raw_fd()).unwrap();
        assert_eq!(before & O_NONBLOCK_STATUS, 0);
        assert_eq!(
            validate_stream(reader.as_raw_fd(), O_RDONLY_ACCESS),
            Err(InvocationError::InvalidStatusFlags)
        );
        // Admission never silently changes the inherited open file description.
        assert_eq!(
            syscall::descriptor_status_flags(reader.as_raw_fd()).unwrap(),
            before
        );

        // An anonymous pipe retains its version-1 representation and access mode when its
        // caller-supplied status is nonblocking.
        let (nonblocking_reader, _nonblocking_writer) = nonblocking_pipe();
        assert!(matches!(
            validate_stream(nonblocking_reader.as_raw_fd(), O_RDONLY_ACCESS),
            Ok(ProtocolStream {
                class: StreamClass::Pipe,
                ..
            })
        ));
        assert_eq!(
            validate_protocol_stream_status_flags(O_RDONLY_ACCESS | O_NONBLOCK_STATUS | 0o20_000,),
            Err(InvocationError::InvalidStatusFlags)
        );

        let (stream, _peer) = std::os::unix::net::UnixStream::pair().unwrap();
        stream.set_nonblocking(true).unwrap();
        assert!(matches!(
            validate_stream(stream.as_raw_fd(), O_RDWR_ACCESS),
            Ok(ProtocolStream {
                class: StreamClass::UnixStream,
                ..
            })
        ));
    }

    #[test]
    fn parent_proof_refuses_every_prelinearization_fault_without_lease() {
        // 14 callbacks occur before the fresh capture is bracketed and LeaseIssued is callback 15.
        for failure in 1..=14 {
            let expected = strict(7);
            let mut fake = FakeParent {
                calls: 0,
                fail_at: Some(failure),
                executable: expected,
                issued: false,
            };
            assert!(
                final_parent_proof_sequence(&mut fake, expected).is_err(),
                "call {failure}"
            );
            assert!(!fake.issued, "call {failure} issued a lease");
        }
    }

    #[test]
    fn parent_exec_before_fresh_capture_refuses_but_later_change_is_not_retroactive() {
        let expected = strict(7);
        let mut changed = FakeParent {
            calls: 0,
            fail_at: None,
            executable: strict(8),
            issued: false,
        };
        assert_eq!(
            final_parent_proof_sequence(&mut changed, expected),
            Err(InvocationError::ParentProof)
        );
        assert!(!changed.issued);

        let mut captured = FakeParent {
            calls: 0,
            fail_at: None,
            executable: expected,
            issued: false,
        };
        assert!(final_parent_proof_sequence(&mut captured, expected).is_ok());
        // The retained result claims equality at capture; a later parent exec is deliberately
        // outside the bounded observation and cannot invalidate the already-issued lease.
        captured.executable = strict(8);
        assert!(captured.issued);
    }

    #[test]
    fn home_and_state_root_replacement_after_cloexec_refuse_before_lease_or_side_effects() {
        let helper = strict(1);
        let home = strict(2).common;
        let state_root = strict(3).common;
        let node = strict(4);
        let script = strict(5);
        let config = strict(6);

        for (role, home_after, state_root_after) in [
            ("home", strict(7).common, state_root),
            ("state-root", home, strict(8).common),
        ] {
            let identities = InvocationDescriptorIdentities {
                helper,
                home,
                state_root,
                node,
                script,
                config,
            };
            let identities_after = InvocationDescriptorIdentities {
                home: home_after,
                state_root: state_root_after,
                ..identities
            };
            assert_eq!(
                require_unchanged_identities_after_cloexec(identities, identities_after),
                Err(InvocationError::Replacement),
                "{role} replacement passed post-CLOEXEC comparison"
            );

            let mut harness = AdmissionHarness {
                fault: Some(match role {
                    "home" => "revalidate-fd4-home",
                    "state-root" => "revalidate-fd5-state-root",
                    _ => unreachable!(),
                }),
                gates: Vec::new(),
                lease: false,
                frame_reads: 0,
                output_bytes: 0,
                durable_mutations: 0,
            };
            assert_eq!(harness.run(), Err(InvocationError::Replacement), "{role}");
            assert!(!harness.lease, "{role} replacement issued a lease");
            assert_eq!(
                harness.frame_reads, 0,
                "{role} replacement consumed a frame"
            );
            assert_eq!(
                harness.output_bytes, 0,
                "{role} replacement wrote helper output"
            );
            assert_eq!(
                harness.durable_mutations, 0,
                "{role} replacement mutated durable state"
            );
        }
    }

    /// A whole-admission harness deliberately has no frame, output, or mutation operation.  Each
    /// gate corresponds to a concrete production admission check and can be failed independently;
    /// this gives deterministic coverage for identities that an unprivileged test process cannot
    /// safely forge (for example root-owned images and a third-UID FD 6 runtime).
    struct AdmissionHarness {
        fault: Option<&'static str>,
        gates: Vec<&'static str>,
        lease: bool,
        frame_reads: u8,
        output_bytes: u8,
        durable_mutations: u8,
    }

    impl AdmissionHarness {
        fn gate(&mut self, name: &'static str) -> Result<(), InvocationError> {
            self.gates.push(name);
            if self.fault == Some(name) {
                return Err(InvocationError::Replacement);
            }
            Ok(())
        }

        fn run(&mut self) -> Result<(), InvocationError> {
            for gate in ADMISSION_GATES {
                self.gate(gate)?;
            }
            self.lease = true;
            Ok(())
        }
    }

    const ADMISSION_GATES: [&str; 43] = [
        "inventory-exact-0-8",
        "inventory-cloexec-clear",
        "stdio-0-type-direction-status",
        "stdio-1-type-direction-status",
        "stdio-2-type-direction-status",
        "stdio-representation-distinct",
        "stdio-underlying-object-distinct",
        "aliases-all-roles",
        "fd3-type",
        "fd3-owner",
        "fd3-mode",
        "fd3-link",
        "fd3-size",
        "fd3-hash-elf",
        "fd3-self-identity",
        "fd4-type-owner-mode",
        "fd5-type-owner-mode",
        "fd4-fd5-nonalias",
        "fd4-lcm-first-identity",
        "fd4-lcm-second-identity",
        "fd6-type-mode-link-size-hash-elf",
        "fd6-third-uid-identity-not-owner-class",
        "fd7-type-owner-mode-link-size-hash",
        "fd7-prefix-utf8",
        "fd8-type-owner-mode-link-size-hash",
        "fd8-json-object-utf8",
        "cloexec-3-through-8",
        "revalidate-fd3-self",
        "revalidate-fd4-home",
        "revalidate-fd5-state-root",
        "revalidate-fd6",
        "revalidate-fd7",
        "revalidate-fd8",
        "parent-ppid-before",
        "parent-pdeathsig",
        "parent-ppid-after",
        "parent-pidfd",
        "parent-namespace-start-live-before",
        "parent-fresh-exe-fd6-equality",
        "parent-namespace-start-live-after",
        "descriptor-set-digest",
        "stable-vacant-lease-binding",
        "lease-issued",
    ];

    #[test]
    fn whole_admission_harness_refuses_every_role_and_race_gate_without_side_effects() {
        for fault in ADMISSION_GATES {
            let mut harness = AdmissionHarness {
                fault: Some(fault),
                gates: Vec::new(),
                lease: false,
                frame_reads: 0,
                output_bytes: 0,
                durable_mutations: 0,
            };
            assert!(harness.run().is_err(), "{fault}");
            assert!(!harness.lease, "{fault} issued a lease");
            assert_eq!(harness.frame_reads, 0, "{fault} consumed a frame");
            assert_eq!(harness.output_bytes, 0, "{fault} wrote helper output");
            assert_eq!(
                harness.durable_mutations, 0,
                "{fault} mutated durable state"
            );
        }
    }

    #[test]
    fn whole_admission_harness_issues_only_after_all_read_only_gates() {
        let mut harness = AdmissionHarness {
            fault: None,
            gates: Vec::new(),
            lease: false,
            frame_reads: 0,
            output_bytes: 0,
            durable_mutations: 0,
        };
        assert!(harness.run().is_ok());
        assert!(harness.lease);
        assert_eq!(harness.gates, ADMISSION_GATES);
        assert_eq!(harness.frame_reads, 0);
        assert_eq!(harness.output_bytes, 0);
        assert_eq!(harness.durable_mutations, 0);
    }

    #[test]
    fn only_explicit_enosys_is_unsupported_preframe() {
        let descriptor_enosys = DescriptorError::Io(Errno::ENOSYS.0);
        for error in [
            // Direct required kcmp, prctl, PIDFD, and procfs syscall paths.
            InvocationError::Syscall(Errno::ENOSYS),
            InvocationError::Descriptor(descriptor_enosys),
            // Descriptor-held stable admission retains every reachable explicit nested form.
            InvocationError::Stable(StableAdmissionError::Syscall(Errno::ENOSYS)),
            InvocationError::Stable(StableAdmissionError::Descriptor(descriptor_enosys)),
            InvocationError::Stable(StableAdmissionError::Persistence(
                PersistenceError::Syscall(Errno::ENOSYS),
            )),
            InvocationError::Stable(StableAdmissionError::Persistence(
                PersistenceError::Descriptor(descriptor_enosys),
            )),
            InvocationError::Stable(StableAdmissionError::Persistence(
                PersistenceError::MutationAmbiguous(descriptor_enosys),
            )),
        ] {
            assert_eq!(classify_pre_frame_error(error), PreFrameResult::Unsupported);
        }
    }

    #[test]
    fn all_non_enosys_top_level_and_nested_failures_are_ambiguous() {
        let descriptor_io = DescriptorError::Io(5);
        for error in [
            InvocationError::Syscall(Errno(1)), // EPERM: e.g. kcmp under policy
            InvocationError::Syscall(Errno(5)), // EIO: procfs observation ambiguity
            InvocationError::Syscall(Errno(2)), // ENOENT: parent/procfs race
            InvocationError::Descriptor(descriptor_io),
            InvocationError::ExtraDescriptor,
            InvocationError::MissingDescriptor,
            InvocationError::CloexecSet,
            InvocationError::InvalidStatusFlags,
            InvocationError::InvalidProtocolStream,
            InvocationError::AliasedDescriptors,
            InvocationError::HelperSelfMismatch,
            InvocationError::InvalidHelperElf,
            InvocationError::InvalidNodeElf,
            InvocationError::InvalidRuntimeScript,
            InvocationError::InvalidConfigSnapshot,
            InvocationError::InvalidHomeStateRelation,
            InvocationError::ParentProof, // changed PPID/start-time/namespace/equality
            InvocationError::Replacement, // descriptor replacement or invalid null probe
            InvocationError::Stable(StableAdmissionError::Syscall(Errno(1))),
            InvocationError::Stable(StableAdmissionError::Descriptor(descriptor_io)),
            InvocationError::Stable(StableAdmissionError::Persistence(
                PersistenceError::Syscall(Errno(5)),
            )),
            InvocationError::Stable(StableAdmissionError::Persistence(
                PersistenceError::Descriptor(descriptor_io),
            )),
            InvocationError::Stable(StableAdmissionError::Persistence(
                PersistenceError::MutationAmbiguous(descriptor_io),
            )),
            InvocationError::Stable(StableAdmissionError::Persistence(PersistenceError::Record(
                crate::record::RecordError::InvalidToken,
            ))),
            InvocationError::Stable(StableAdmissionError::InvalidToken),
            InvocationError::Stable(StableAdmissionError::AuthorityMismatch),
            InvocationError::Stable(StableAdmissionError::LayoutNotStable),
            InvocationError::Stable(StableAdmissionError::Replacement),
        ] {
            assert_eq!(classify_pre_frame_error(error), PreFrameResult::Ambiguous);
        }
    }

    #[test]
    fn rename_probe_recognizes_only_efault_and_preserves_enosys_classification() {
        assert!(classify_renameat2_probe(Err(Errno::EFAULT)).is_ok());
        assert_eq!(
            classify_renameat2_probe(Err(Errno::ENOSYS)),
            Err(InvocationError::Syscall(Errno::ENOSYS))
        );
        assert_eq!(
            classify_renameat2_probe(Err(Errno(1))),
            Err(InvocationError::Syscall(Errno(1)))
        );
        assert_eq!(
            classify_renameat2_probe(Ok(())),
            Err(InvocationError::Replacement)
        );
    }

    #[test]
    fn production_syscall_source_has_no_ambient_cwd_probe() {
        let syscall_source = include_str!("syscall.rs");
        assert!(!syscall_source.contains(&["AT", "_FDCWD"].concat()));
        assert!(!syscall_source.contains(&["probe_", "openat2"].concat()));
        let main_source = include_str!("main.rs");
        assert!(!main_source.contains(&["capability", "::probe"].concat()));
    }
}
