//! Linux x86_64 raw-syscall wrappers.
//!
//! Kernel negative return values are converted directly into [`Errno`]. No libc errno slot is
//! consulted or rewritten, so the exact kernel failure is retained for fail-closed decisions.

use crate::descriptor::Descriptor;
use core::arch::asm;
use std::ffi::CStr;
use std::os::fd::{AsRawFd, BorrowedFd, RawFd};

const SYS_RENAMEAT2: usize = 316;
const SYS_PIDFD_SEND_SIGNAL: usize = 424;
const SYS_PIDFD_OPEN: usize = 434;
const SYS_OPENAT2: usize = 437;

const AT_FDCWD: RawFd = -100;
const O_DIRECTORY: u64 = 0o200000;
const O_NOFOLLOW: u64 = 0o400000;
const O_CLOEXEC: u64 = 0o2000000;
const O_PATH: u64 = 0o10000000;
const O_NONBLOCK: u64 = 0o4000;

const RESOLVE_NO_XDEV: u64 = 0x01;
const RESOLVE_NO_MAGICLINKS: u64 = 0x02;
const RESOLVE_NO_SYMLINKS: u64 = 0x04;
const RESOLVE_BENEATH: u64 = 0x08;

const RENAME_NOREPLACE: usize = 1;
const RENAME_EXCHANGE: usize = 2;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Errno(pub i32);

impl Errno {
    pub const ENOSYS: Self = Self(38);
    pub const EINVAL: Self = Self(22);
    pub const EFAULT: Self = Self(14);
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerminatingSignal {
    Term,
    Kill,
}

impl TerminatingSignal {
    const fn number(self) -> usize {
        match self {
            Self::Term => 15,
            Self::Kill => 9,
        }
    }
}

#[derive(Debug)]
pub struct PidFd(Descriptor);

impl PidFd {
    pub fn open(pid: u32) -> Result<Self, Errno> {
        if pid == 0 || pid > i32::MAX as u32 {
            return Err(Errno::EINVAL);
        }
        let fd = pidfd_open_with(&LinuxRaw, pid)?;
        // SAFETY: a successful pidfd_open returns a new owned descriptor.
        Ok(Self(unsafe { Descriptor::from_owned_raw_fd(fd) }))
    }

    pub fn send(&self, signal: TerminatingSignal) -> Result<(), Errno> {
        pidfd_send_signal_with(&LinuxRaw, self.0.as_raw_fd(), signal.number())
    }

    pub fn descriptor(&self) -> &Descriptor {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OpenAccess {
    Path { directory: bool },
    ReadOnly { directory: bool },
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
struct OpenHow {
    flags: u64,
    mode: u64,
    resolve: u64,
}

pub fn open_beneath<'fd>(
    parent: BorrowedFd<'fd>,
    component: &CStr,
    access: OpenAccess,
) -> Result<Descriptor, Errno> {
    validate_component(component)?;
    let (mut flags, directory) = match access {
        OpenAccess::Path { directory } => (O_PATH, directory),
        OpenAccess::ReadOnly { directory } => (O_NONBLOCK, directory),
    };
    flags |= O_CLOEXEC | O_NOFOLLOW;
    if directory {
        flags |= O_DIRECTORY;
    }
    let how = OpenHow {
        flags,
        mode: 0,
        resolve: RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS | RESOLVE_NO_XDEV,
    };
    let fd = openat2_with(&LinuxRaw, parent.as_raw_fd(), component, &how)?;
    // SAFETY: a successful openat2 returns a new owned descriptor.
    Ok(unsafe { Descriptor::from_owned_raw_fd(fd) })
}

pub fn rename_noreplace<'fd>(
    old_parent: BorrowedFd<'fd>,
    old_name: &CStr,
    new_parent: BorrowedFd<'fd>,
    new_name: &CStr,
) -> Result<(), Errno> {
    rename_with_validated_components(old_parent, old_name, new_parent, new_name, RENAME_NOREPLACE)
}

pub fn rename_exchange<'fd>(
    old_parent: BorrowedFd<'fd>,
    old_name: &CStr,
    new_parent: BorrowedFd<'fd>,
    new_name: &CStr,
) -> Result<(), Errno> {
    rename_with_validated_components(old_parent, old_name, new_parent, new_name, RENAME_EXCHANGE)
}

fn rename_with_validated_components<'fd>(
    old_parent: BorrowedFd<'fd>,
    old_name: &CStr,
    new_parent: BorrowedFd<'fd>,
    new_name: &CStr,
    flags: usize,
) -> Result<(), Errno> {
    validate_component(old_name)?;
    validate_component(new_name)?;
    renameat2_with(
        &LinuxRaw,
        old_parent.as_raw_fd(),
        old_name,
        new_parent.as_raw_fd(),
        new_name,
        flags,
    )
}

fn validate_component(component: &CStr) -> Result<(), Errno> {
    let bytes = component.to_bytes();
    if bytes.is_empty() || bytes == b"." || bytes == b".." || bytes.contains(&b'/') {
        return Err(Errno::EINVAL);
    }
    Ok(())
}

pub(crate) trait RawSyscalls {
    /// # Safety
    ///
    /// Pointer arguments must be valid for the selected syscall. The kernel may read or write
    /// through them according to that syscall's ABI.
    unsafe fn call6(&self, number: usize, arguments: [usize; 6]) -> isize;
}

pub(crate) struct LinuxRaw;

impl RawSyscalls for LinuxRaw {
    unsafe fn call6(&self, number: usize, arguments: [usize; 6]) -> isize {
        let result: isize;
        // SAFETY: the caller upholds the selected syscall's pointer and argument contract.
        unsafe {
            asm!(
                "syscall",
                inlateout("rax") number as isize => result,
                in("rdi") arguments[0],
                in("rsi") arguments[1],
                in("rdx") arguments[2],
                in("r10") arguments[3],
                in("r8") arguments[4],
                in("r9") arguments[5],
                lateout("rcx") _,
                lateout("r11") _,
                options(nostack),
            );
        }
        result
    }
}

pub(crate) fn decode_result(value: isize) -> Result<usize, Errno> {
    if (-4095..=-1).contains(&value) {
        Err(Errno((-value) as i32))
    } else {
        Ok(value as usize)
    }
}

fn pidfd_open_with(raw: &impl RawSyscalls, pid: u32) -> Result<RawFd, Errno> {
    // SAFETY: pidfd_open has no pointer arguments; flags are fixed to zero.
    let value = unsafe { raw.call6(SYS_PIDFD_OPEN, [pid as usize, 0, 0, 0, 0, 0]) };
    Ok(decode_result(value)? as RawFd)
}

pub(crate) fn pidfd_send_signal_with(
    raw: &impl RawSyscalls,
    pidfd: RawFd,
    signal: usize,
) -> Result<(), Errno> {
    // SAFETY: siginfo is null and flags are zero; the descriptor is only consumed by the kernel.
    let value = unsafe { raw.call6(SYS_PIDFD_SEND_SIGNAL, [pidfd as usize, signal, 0, 0, 0, 0]) };
    decode_result(value).map(|_| ())
}

fn openat2_with(
    raw: &impl RawSyscalls,
    parent: RawFd,
    component: &CStr,
    how: &OpenHow,
) -> Result<RawFd, Errno> {
    // SAFETY: component and how remain valid and immutable for the duration of the syscall.
    let value = unsafe {
        raw.call6(
            SYS_OPENAT2,
            [
                parent as usize,
                component.as_ptr() as usize,
                core::ptr::from_ref(how) as usize,
                core::mem::size_of::<OpenHow>(),
                0,
                0,
            ],
        )
    };
    Ok(decode_result(value)? as RawFd)
}

fn renameat2_with(
    raw: &impl RawSyscalls,
    old_parent: RawFd,
    old_name: &CStr,
    new_parent: RawFd,
    new_name: &CStr,
    flags: usize,
) -> Result<(), Errno> {
    // SAFETY: both NUL-terminated names remain valid and immutable during the syscall.
    let value = unsafe {
        raw.call6(
            SYS_RENAMEAT2,
            [
                old_parent as usize,
                old_name.as_ptr() as usize,
                new_parent as usize,
                new_name.as_ptr() as usize,
                flags,
                0,
            ],
        )
    };
    decode_result(value).map(|_| ())
}

pub(crate) fn probe_openat2(raw: &impl RawSyscalls) -> Result<RawFd, Errno> {
    let name = c".";
    let how = OpenHow {
        flags: O_PATH | O_DIRECTORY | O_CLOEXEC,
        mode: 0,
        resolve: RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS,
    };
    openat2_with(raw, AT_FDCWD, name, &how)
}

pub(crate) fn probe_rename_flag(raw: &impl RawSyscalls, flag: usize) -> Result<(), Errno> {
    // Deliberately invalid null paths distinguish a recognized syscall/flag (EFAULT) without
    // changing any namespace entry. EFAULT is consumed by the capability probe as success.
    // SAFETY: null paths are intentionally passed to provoke a side-effect-free kernel error.
    let value = unsafe {
        raw.call6(
            SYS_RENAMEAT2,
            [AT_FDCWD as usize, 0, AT_FDCWD as usize, 0, flag, 0],
        )
    };
    decode_result(value).map(|_| ())
}

pub(crate) const PROBE_RENAME_NOREPLACE: usize = RENAME_NOREPLACE;
pub(crate) const PROBE_RENAME_EXCHANGE: usize = RENAME_EXCHANGE;

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct FakeRaw {
        result: isize,
        calls: RefCell<Vec<(usize, [usize; 6])>>,
    }

    impl RawSyscalls for FakeRaw {
        unsafe fn call6(&self, number: usize, arguments: [usize; 6]) -> isize {
            self.calls.borrow_mut().push((number, arguments));
            self.result
        }
    }

    #[test]
    fn preserves_exact_kernel_errno() {
        for errno in [1, 14, 22, 38, 95, 4095] {
            assert_eq!(decode_result(-(errno as isize)), Err(Errno(errno)));
        }
        assert_eq!(decode_result(7), Ok(7));
    }

    #[test]
    fn pidfd_wrappers_fix_flags_and_signal_info() {
        let raw = FakeRaw {
            result: -95,
            calls: RefCell::new(Vec::new()),
        };
        assert_eq!(pidfd_open_with(&raw, 41), Err(Errno(95)));
        assert_eq!(raw.calls.borrow()[0], (SYS_PIDFD_OPEN, [41, 0, 0, 0, 0, 0]));

        assert_eq!(pidfd_send_signal_with(&raw, 12, 15), Err(Errno(95)));
        assert_eq!(
            raw.calls.borrow()[1],
            (SYS_PIDFD_SEND_SIGNAL, [12, 15, 0, 0, 0, 0])
        );
    }

    #[test]
    fn rename_wrapper_preserves_flag_and_errno() {
        let raw = FakeRaw {
            result: -38,
            calls: RefCell::new(Vec::new()),
        };
        assert_eq!(
            renameat2_with(&raw, 3, c"old", 4, c"new", RENAME_EXCHANGE),
            Err(Errno::ENOSYS)
        );
        let call = raw.calls.borrow()[0];
        assert_eq!(call.0, SYS_RENAMEAT2);
        assert_eq!(call.1[0], 3);
        assert_eq!(call.1[2], 4);
        assert_eq!(call.1[4], RENAME_EXCHANGE);
    }

    #[test]
    fn openat2_wrapper_preserves_errno_and_bounded_resolution_contract() {
        let raw = FakeRaw {
            result: -1,
            calls: RefCell::new(Vec::new()),
        };
        let how = OpenHow {
            flags: O_PATH | O_CLOEXEC | O_NOFOLLOW,
            mode: 0,
            resolve: RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS,
        };
        assert_eq!(openat2_with(&raw, 7, c"leaf", &how), Err(Errno(1)));
        let call = raw.calls.borrow()[0];
        assert_eq!(call.0, SYS_OPENAT2);
        assert_eq!(call.1[0], 7);
        assert_eq!(call.1[3], core::mem::size_of::<OpenHow>());
    }

    #[test]
    fn components_never_expand_into_paths() {
        for component in [c"", c".", c"..", c"child/name"] {
            assert_eq!(validate_component(component), Err(Errno::EINVAL));
        }
        assert_eq!(validate_component(c"child"), Ok(()));
    }

    #[test]
    fn public_pidfd_rejects_ambiguous_numeric_subjects_without_syscall() {
        assert_eq!(PidFd::open(0).unwrap_err(), Errno::EINVAL);
        assert_eq!(
            PidFd::open((i32::MAX as u32) + 1).unwrap_err(),
            Errno::EINVAL
        );
    }
}
