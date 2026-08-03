//! Linux x86_64 raw-syscall wrappers.
//!
//! Kernel negative return values are converted directly into [`Errno`]. No libc errno slot is
//! consulted or rewritten, so the exact kernel failure is retained for fail-closed decisions.

use crate::descriptor::Descriptor;
use core::arch::asm;
use std::ffi::CStr;
use std::os::fd::{AsRawFd, BorrowedFd, RawFd};

const SYS_RENAMEAT2: usize = 316;
const SYS_MKDIRAT: usize = 258;
const SYS_GETDENTS64: usize = 217;
const SYS_LSEEK: usize = 8;
const SYS_PIDFD_SEND_SIGNAL: usize = 424;
const SYS_PIDFD_OPEN: usize = 434;
const SYS_OPENAT2: usize = 437;

const AT_FDCWD: RawFd = -100;
const O_DIRECTORY: u64 = 0o200000;
const O_NOFOLLOW: u64 = 0o400000;
const O_CLOEXEC: u64 = 0o2000000;
const O_PATH: u64 = 0o10000000;
const O_NONBLOCK: u64 = 0o4000;
const O_WRONLY: u64 = 1;
const O_RDWR: u64 = 2;
const O_CREAT: u64 = 0o100;
const O_EXCL: u64 = 0o200;

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
    ReadWriteLock,
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
        OpenAccess::ReadWriteLock => (O_RDWR | O_NONBLOCK, false),
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

pub fn create_exclusive<'fd>(
    parent: BorrowedFd<'fd>,
    component: &CStr,
    mode: u32,
) -> Result<Descriptor, Errno> {
    validate_component(component)?;
    if mode == 0 || mode > 0o777 {
        return Err(Errno::EINVAL);
    }
    let how = OpenHow {
        flags: O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
        mode: mode as u64,
        resolve: RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS | RESOLVE_NO_XDEV,
    };
    let fd = openat2_with(&LinuxRaw, parent.as_raw_fd(), component, &how)?;
    // SAFETY: a successful exclusive openat2 returns a new owned descriptor.
    Ok(unsafe { Descriptor::from_owned_raw_fd(fd) })
}

pub fn mkdir_beneath<'fd>(
    parent: BorrowedFd<'fd>,
    component: &CStr,
    mode: u32,
) -> Result<(), Errno> {
    validate_component(component)?;
    if mode == 0 || mode > 0o777 {
        return Err(Errno::EINVAL);
    }
    // SAFETY: component is a valid immutable C string for the syscall duration.
    let value = unsafe {
        LinuxRaw.call6(
            SYS_MKDIRAT,
            [
                parent.as_raw_fd() as usize,
                component.as_ptr() as usize,
                mode as usize,
                0,
                0,
                0,
            ],
        )
    };
    decode_result(value).map(|_| ())
}

pub fn list_directory<'fd>(
    directory: BorrowedFd<'fd>,
    maximum_entries: usize,
) -> Result<Vec<Vec<u8>>, Errno> {
    if maximum_entries == 0 || maximum_entries > 64 {
        return Err(Errno::EINVAL);
    }
    seek_directory_start(directory.as_raw_fd())?;
    let result = list_directory_from_current_offset(directory.as_raw_fd(), maximum_entries);
    let reset = seek_directory_start(directory.as_raw_fd());
    match (result, reset) {
        (Ok(entries), Ok(())) => Ok(entries),
        (Err(error), _) | (Ok(_), Err(error)) => Err(error),
    }
}

fn list_directory_from_current_offset(
    descriptor: RawFd,
    maximum_entries: usize,
) -> Result<Vec<Vec<u8>>, Errno> {
    let mut entries = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        // SAFETY: buffer is writable for its complete length during getdents64.
        let value = unsafe {
            LinuxRaw.call6(
                SYS_GETDENTS64,
                [
                    descriptor as usize,
                    buffer.as_mut_ptr() as usize,
                    buffer.len(),
                    0,
                    0,
                    0,
                ],
            )
        };
        let count = decode_result(value)?;
        if count == 0 {
            break;
        }
        if count > buffer.len() {
            return Err(Errno::EINVAL);
        }
        let mut offset = 0_usize;
        while offset < count {
            if count - offset < 19 {
                return Err(Errno::EINVAL);
            }
            let record_length =
                u16::from_ne_bytes([buffer[offset + 16], buffer[offset + 17]]) as usize;
            if record_length < 20 || record_length > count - offset {
                return Err(Errno::EINVAL);
            }
            let name_field = &buffer[offset + 19..offset + record_length];
            let nul = name_field
                .iter()
                .position(|byte| *byte == 0)
                .ok_or(Errno::EINVAL)?;
            let name = &name_field[..nul];
            if name != b"." && name != b".." {
                if name.is_empty() || name.contains(&b'/') || entries.len() == maximum_entries {
                    return Err(Errno::EINVAL);
                }
                entries.push(name.to_vec());
            }
            offset += record_length;
        }
    }
    entries.sort_unstable();
    if entries.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(Errno::EINVAL);
    }
    Ok(entries)
}

fn seek_directory_start(descriptor: RawFd) -> Result<(), Errno> {
    // SAFETY: lseek has no pointer arguments and offset/whence are fixed to the directory start.
    let value = unsafe { LinuxRaw.call6(SYS_LSEEK, [descriptor as usize, 0, 0, 0, 0, 0]) };
    decode_result(value).map(|_| ())
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

#[repr(C)]
#[derive(Clone, Copy)]
struct Flock {
    lock_type: i16,
    whence: i16,
    start: i64,
    length: i64,
    pid: i32,
    padding: i32,
}

const SYS_FCNTL: usize = 72;
const F_OFD_SETLK: usize = 37;
const F_WRITE_LOCK: i16 = 1;
const F_UNLOCK: i16 = 2;

pub(crate) fn ofd_lock_with(
    raw: &impl RawSyscalls,
    descriptor: RawFd,
    lock_type: i16,
) -> Result<(), Errno> {
    let lock = Flock {
        lock_type,
        whence: 0,
        start: 0,
        length: 0,
        pid: 0,
        padding: 0,
    };
    // SAFETY: lock is a valid immutable flock structure for this nonblocking fcntl operation.
    let value = unsafe {
        raw.call6(
            SYS_FCNTL,
            [
                descriptor as usize,
                F_OFD_SETLK,
                core::ptr::from_ref(&lock) as usize,
                0,
                0,
                0,
            ],
        )
    };
    decode_result(value).map(|_| ())
}

pub(crate) fn acquire_ofd_lock(descriptor: RawFd) -> Result<(), Errno> {
    ofd_lock_with(&LinuxRaw, descriptor, F_WRITE_LOCK)
}

pub(crate) fn release_ofd_lock(descriptor: RawFd) -> Result<(), Errno> {
    ofd_lock_with(&LinuxRaw, descriptor, F_UNLOCK)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::fs::{self, File};
    use std::os::fd::AsFd;
    use std::time::{SystemTime, UNIX_EPOCH};

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

    #[test]
    fn ofd_lock_is_exclusive_nonblocking_and_preserves_errno() {
        let raw = FakeRaw {
            result: -11,
            calls: RefCell::new(Vec::new()),
        };
        assert_eq!(ofd_lock_with(&raw, 8, F_WRITE_LOCK), Err(Errno(11)));
        let call = raw.calls.borrow()[0];
        assert_eq!(call.0, SYS_FCNTL);
        assert_eq!(call.1[0], 8);
        assert_eq!(call.1[1], F_OFD_SETLK);
        // SAFETY: the pointer remains valid until ofd_lock_with returns; FakeRaw inspected it
        // synchronously and stored only its address, so do not dereference it here.
    }

    #[test]
    fn directory_listing_is_bounded_sorted_and_offset_independent() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "lcm-helper-getdents-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap();
        fs::write(path.join("zeta"), b"").unwrap();
        fs::write(path.join("alpha"), b"").unwrap();
        let directory = File::open(&path).unwrap();
        assert_eq!(
            list_directory(directory.as_fd(), 2),
            Ok(vec![b"alpha".to_vec(), b"zeta".to_vec()])
        );
        assert_eq!(
            list_directory(directory.as_fd(), 2),
            Ok(vec![b"alpha".to_vec(), b"zeta".to_vec()])
        );
        assert_eq!(list_directory(directory.as_fd(), 1), Err(Errno::EINVAL));
        drop(directory);
        fs::remove_dir_all(path).unwrap();
    }
}
