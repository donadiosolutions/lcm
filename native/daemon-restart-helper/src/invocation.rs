//! Read-only admission for the fixed version-1 inherited helper descriptor ABI.
//!
//! This module deliberately stops at an in-memory lease.  It never consumes a protocol byte,
//! writes a diagnostic, alters a durable object, or exposes a dispatch/spawn capability.

use crate::descriptor::{
    Descriptor, DescriptorContent, DescriptorError, DescriptorIdentity, DescriptorIdentityCommon,
    DescriptorKind, DescriptorPolicy,
};
use crate::stable::{self, PreverifiedHelperDigest, StableAdmissionError, StableVacantLease};
use crate::syscall::{
    self, Errno, O_LARGEFILE_STATUS, O_NONBLOCK_STATUS, O_RDONLY_ACCESS, O_RDWR_ACCESS,
    O_WRONLY_ACCESS, PidFd,
};
use std::fs::{self, File};
use std::mem;
use std::os::fd::{AsFd, AsRawFd};
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StreamClass {
    Pipe,
    UnixStream,
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
    let owner_uid = syscall::effective_uid().map_err(InvocationError::Syscall)?;
    let owner_gid = syscall::effective_gid().map_err(InvocationError::Syscall)?;
    let state_root = invocation
        .state_root
        .try_clone()
        .map_err(InvocationError::Descriptor)?;
    let stable = stable::admit_stable_vacant(
        state_root,
        owner_uid,
        owner_gid,
        PreverifiedHelperDigest::new(invocation.helper_digest),
    )
    .map_err(InvocationError::Stable)?;
    Ok(InvocationLease {
        _invocation: invocation,
        _stable: stable,
    })
}

/// Attempts the complete read-only invocation admission.  Error details deliberately stay inside
/// the helper: pre-frame failures have one externally observable outcome, exit status 78.
pub fn admit() -> bool {
    admit_with_stable_lease().is_ok()
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
        if helper_after != helper
            || node_after != node
            || script_after != script
            || config_after != config
        {
            return Err(InvocationError::Replacement);
        }
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
    let mut seen = [false; 9];
    for entry in entries {
        let text = std::str::from_utf8(&entry).map_err(|_| InvocationError::ExtraDescriptor)?;
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

fn validate_streams() -> Result<(), InvocationError> {
    let classes = [
        validate_stream(0, O_RDONLY_ACCESS)?,
        validate_stream(1, O_WRONLY_ACCESS)?,
        validate_stream(2, O_WRONLY_ACCESS)?,
    ];
    if classes.windows(2).any(|pair| pair[0] != pair[1]) {
        return Err(InvocationError::InvalidProtocolStream);
    }
    Ok(())
}

fn validate_stream(descriptor: i32, access: usize) -> Result<StreamClass, InvocationError> {
    let flags = syscall::descriptor_status_flags(descriptor).map_err(InvocationError::Syscall)?;
    if flags & !(3 | O_NONBLOCK_STATUS | O_LARGEFILE_STATUS) != 0 {
        return Err(InvocationError::InvalidStatusFlags);
    }
    let target = fs::read_link(format!("/proc/self/fd/{descriptor}"))
        .map_err(|_| InvocationError::InvalidProtocolStream)?;
    let target = target.as_os_str().as_encoded_bytes();
    if target.starts_with(b"pipe:[") && target.ends_with(b"]") {
        if flags & 3 != access {
            return Err(InvocationError::InvalidProtocolStream);
        }
        return Ok(StreamClass::Pipe);
    }
    if target.starts_with(b"socket:[")
        && target.ends_with(b"]")
        && flags & 3 == O_RDWR_ACCESS
        && syscall::is_connected_unnamed_unix_stream(descriptor)
            .map_err(InvocationError::Syscall)?
    {
        return Ok(StreamClass::UnixStream);
    }
    Err(InvocationError::InvalidProtocolStream)
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
}
