//! Side-effect-free admission probe for the required Linux x86_64 syscall ABI.

use crate::descriptor::Descriptor;
use crate::syscall::{self, Errno, LinuxRaw, PROBE_RENAME_EXCHANGE, PROBE_RENAME_NOREPLACE, PidFd};
use std::os::fd::AsRawFd;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Capability {
    PidFdOpen,
    PidFdSendSignal,
    OpenAt2,
    RenameNoReplace,
    RenameExchange,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProbeError {
    Unavailable {
        capability: Capability,
        errno: Errno,
    },
    Ambiguous {
        capability: Capability,
        errno: Option<Errno>,
    },
}

/// Proof that this invocation observed the required raw syscall entry points.
///
/// This is an ABI admission result only. Each later filesystem transition must still validate its
/// exact filesystem semantics and fail closed on an unsupported or ambiguous error.
#[derive(Debug, Eq, PartialEq)]
pub struct VerifiedCapabilities {
    _private: (),
}

pub fn probe() -> Result<VerifiedCapabilities, ProbeError> {
    probe_with(&LinuxProbe)
}

trait ProbeBackend {
    type PidFd;
    type OpenFd;

    fn pidfd_open_self(&self) -> Result<Self::PidFd, Errno>;
    fn pidfd_signal_zero(&self, pidfd: &Self::PidFd) -> Result<(), Errno>;
    fn openat2_current_directory(&self) -> Result<Self::OpenFd, Errno>;
    fn rename_flag(&self, flag: usize) -> Result<(), Errno>;
}

struct LinuxProbe;

impl ProbeBackend for LinuxProbe {
    type PidFd = PidFd;
    type OpenFd = Descriptor;

    fn pidfd_open_self(&self) -> Result<Self::PidFd, Errno> {
        PidFd::open(std::process::id())
    }

    fn pidfd_signal_zero(&self, pidfd: &Self::PidFd) -> Result<(), Errno> {
        syscall::pidfd_send_signal_with(&LinuxRaw, pidfd.descriptor().as_raw_fd(), 0)
    }

    fn openat2_current_directory(&self) -> Result<Self::OpenFd, Errno> {
        let fd = syscall::probe_openat2(&LinuxRaw)?;
        // SAFETY: a successful openat2 returns a new owned descriptor.
        Ok(unsafe { Descriptor::from_owned_raw_fd(fd) })
    }

    fn rename_flag(&self, flag: usize) -> Result<(), Errno> {
        syscall::probe_rename_flag(&LinuxRaw, flag)
    }
}

fn probe_with(backend: &impl ProbeBackend) -> Result<VerifiedCapabilities, ProbeError> {
    let pidfd = backend
        .pidfd_open_self()
        .map_err(|errno| unavailable(Capability::PidFdOpen, errno))?;
    backend
        .pidfd_signal_zero(&pidfd)
        .map_err(|errno| unavailable(Capability::PidFdSendSignal, errno))?;
    let _directory = backend
        .openat2_current_directory()
        .map_err(|errno| unavailable(Capability::OpenAt2, errno))?;
    expect_rename_fault(
        backend.rename_flag(PROBE_RENAME_NOREPLACE),
        Capability::RenameNoReplace,
    )?;
    expect_rename_fault(
        backend.rename_flag(PROBE_RENAME_EXCHANGE),
        Capability::RenameExchange,
    )?;
    Ok(VerifiedCapabilities { _private: () })
}

fn unavailable(capability: Capability, errno: Errno) -> ProbeError {
    if errno == Errno::ENOSYS {
        ProbeError::Unavailable { capability, errno }
    } else {
        ProbeError::Ambiguous {
            capability,
            errno: Some(errno),
        }
    }
}

fn expect_rename_fault(
    result: Result<(), Errno>,
    capability: Capability,
) -> Result<(), ProbeError> {
    match result {
        Err(errno) if errno == Errno::EFAULT => Ok(()),
        Err(errno) if errno == Errno::ENOSYS => Err(ProbeError::Unavailable { capability, errno }),
        Err(errno) => Err(ProbeError::Ambiguous {
            capability,
            errno: Some(errno),
        }),
        Ok(()) => Err(ProbeError::Ambiguous {
            capability,
            errno: None,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    struct FakeProbe {
        pidfd_open: Result<(), Errno>,
        pidfd_signal: Result<(), Errno>,
        openat2: Result<(), Errno>,
        rename_results: RefCell<Vec<Result<(), Errno>>>,
        calls: Cell<usize>,
    }

    impl ProbeBackend for FakeProbe {
        type PidFd = ();
        type OpenFd = ();

        fn pidfd_open_self(&self) -> Result<Self::PidFd, Errno> {
            self.calls.set(self.calls.get() + 1);
            self.pidfd_open
        }

        fn pidfd_signal_zero(&self, _pidfd: &Self::PidFd) -> Result<(), Errno> {
            self.calls.set(self.calls.get() + 1);
            self.pidfd_signal
        }

        fn openat2_current_directory(&self) -> Result<Self::OpenFd, Errno> {
            self.calls.set(self.calls.get() + 1);
            self.openat2
        }

        fn rename_flag(&self, _flag: usize) -> Result<(), Errno> {
            self.calls.set(self.calls.get() + 1);
            self.rename_results.borrow_mut().remove(0)
        }
    }

    fn successful_probe() -> FakeProbe {
        FakeProbe {
            pidfd_open: Ok(()),
            pidfd_signal: Ok(()),
            openat2: Ok(()),
            rename_results: RefCell::new(vec![Err(Errno::EFAULT), Err(Errno::EFAULT)]),
            calls: Cell::new(0),
        }
    }

    #[test]
    fn accepts_only_the_complete_side_effect_free_probe() {
        let fake = successful_probe();
        assert!(probe_with(&fake).is_ok());
        assert_eq!(fake.calls.get(), 5);
    }

    #[test]
    fn enosys_is_unavailable_and_stops_immediately() {
        let mut fake = successful_probe();
        fake.pidfd_open = Err(Errno::ENOSYS);
        assert!(matches!(
            probe_with(&fake),
            Err(ProbeError::Unavailable {
                capability: Capability::PidFdOpen,
                errno: Errno::ENOSYS,
            })
        ));
        assert_eq!(fake.calls.get(), 1);
    }

    #[test]
    fn permission_and_unexpected_results_are_ambiguous() {
        let mut fake = successful_probe();
        fake.openat2 = Err(Errno(1));
        assert_eq!(
            probe_with(&fake),
            Err(ProbeError::Ambiguous {
                capability: Capability::OpenAt2,
                errno: Some(Errno(1)),
            })
        );

        assert_eq!(
            expect_rename_fault(Ok(()), Capability::RenameExchange),
            Err(ProbeError::Ambiguous {
                capability: Capability::RenameExchange,
                errno: None,
            })
        );
        assert_eq!(
            expect_rename_fault(Err(Errno(95)), Capability::RenameExchange),
            Err(ProbeError::Ambiguous {
                capability: Capability::RenameExchange,
                errno: Some(Errno(95)),
            })
        );
    }

    #[test]
    fn live_probe_mutates_no_daemon_state() {
        probe().expect("current Linux x64 kernel supports foundation syscalls");
    }
}
