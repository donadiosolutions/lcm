//! RAII descriptor ownership and descriptor-observed identity validation.

use std::fs::File;
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, RawFd};
use std::os::unix::fs::MetadataExt;

const FILE_TYPE_MASK: u32 = 0o170000;
const FILE_TYPE_REGULAR: u32 = 0o100000;
const FILE_TYPE_DIRECTORY: u32 = 0o040000;

#[derive(Debug)]
pub struct Descriptor(File);

impl Descriptor {
    /// Takes ownership of a descriptor returned by a successful descriptor-creating syscall.
    ///
    /// # Safety
    ///
    /// `fd` must be a valid, newly owned descriptor that is not owned anywhere else.
    pub(crate) unsafe fn from_owned_raw_fd(fd: RawFd) -> Self {
        // SAFETY: the caller transfers unique ownership of a valid descriptor.
        Self(unsafe { File::from_raw_fd(fd) })
    }

    pub fn from_file(file: File) -> Self {
        Self(file)
    }

    pub fn as_fd(&self) -> BorrowedFd<'_> {
        self.0.as_fd()
    }

    pub fn validate(
        &self,
        policy: DescriptorPolicy,
    ) -> Result<DescriptorIdentity, DescriptorError> {
        let metadata = self
            .0
            .metadata()
            .map_err(|error| DescriptorError::Io(error.raw_os_error().unwrap_or(5)))?;
        let mode = metadata.mode();
        let observed_kind = mode & FILE_TYPE_MASK;
        let expected_kind = match policy.kind {
            DescriptorKind::Directory => FILE_TYPE_DIRECTORY,
            DescriptorKind::RegularFile => FILE_TYPE_REGULAR,
        };
        if observed_kind != expected_kind {
            return Err(DescriptorError::WrongKind);
        }
        if metadata.uid() != policy.owner_uid {
            return Err(DescriptorError::WrongOwner);
        }
        if mode & 0o7777 != policy.exact_mode {
            return Err(DescriptorError::WrongMode);
        }
        if policy.require_single_link && metadata.nlink() != 1 {
            return Err(DescriptorError::WrongLinkCount);
        }
        if let Some(max_size) = policy.max_size
            && metadata.size() > max_size
        {
            return Err(DescriptorError::TooLarge);
        }

        let common = DescriptorIdentityCommon {
            device: metadata.dev(),
            inode: metadata.ino(),
            uid: metadata.uid(),
            gid: metadata.gid(),
            mode: mode & 0o7777,
        };
        Ok(match policy.kind {
            DescriptorKind::Directory => DescriptorIdentity::StableDirectory(common),
            DescriptorKind::RegularFile => DescriptorIdentity::StrictLeaf {
                common,
                link_count: metadata.nlink(),
                size: metadata.size(),
            },
        })
    }
}

impl AsRawFd for Descriptor {
    fn as_raw_fd(&self) -> RawFd {
        self.0.as_raw_fd()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DescriptorKind {
    Directory,
    RegularFile,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DescriptorPolicy {
    pub kind: DescriptorKind,
    pub owner_uid: u32,
    pub exact_mode: u32,
    pub require_single_link: bool,
    pub max_size: Option<u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DescriptorIdentityCommon {
    pub device: u64,
    pub inode: u64,
    pub uid: u32,
    pub gid: u32,
    pub mode: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DescriptorIdentity {
    /// Stable directory authority deliberately excludes mutable link count, size, and timestamps.
    StableDirectory(DescriptorIdentityCommon),
    /// Immutable leaves additionally bind link count and bounded size.
    StrictLeaf {
        common: DescriptorIdentityCommon,
        link_count: u64,
        size: u64,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DescriptorError {
    Io(i32),
    WrongKind,
    WrongOwner,
    WrongMode,
    WrongLinkCount,
    TooLarge,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::syscall::{OpenAccess, open_beneath};
    use std::fs::{self, OpenOptions};
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt, symlink};
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
                "lcm-helper-descriptor-{}-{nonce}",
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

    fn current_uid(path: &PathBuf) -> u32 {
        fs::metadata(path).unwrap().uid()
    }

    #[test]
    fn distinguishes_stable_directory_and_strict_leaf_identity() {
        let temporary = TestDirectory::create();
        let uid = current_uid(&temporary.0);
        let directory = Descriptor::from_file(File::open(&temporary.0).unwrap());
        let identity = directory
            .validate(DescriptorPolicy {
                kind: DescriptorKind::Directory,
                owner_uid: uid,
                exact_mode: 0o700,
                require_single_link: false,
                max_size: None,
            })
            .unwrap();
        assert!(matches!(identity, DescriptorIdentity::StableDirectory(_)));

        let leaf_path = temporary.0.join("leaf");
        let leaf = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&leaf_path)
            .unwrap();
        let leaf = Descriptor::from_file(leaf);
        assert!(matches!(
            leaf.validate(DescriptorPolicy {
                kind: DescriptorKind::RegularFile,
                owner_uid: uid,
                exact_mode: 0o600,
                require_single_link: true,
                max_size: Some(0),
            }),
            Ok(DescriptorIdentity::StrictLeaf {
                link_count: 1,
                size: 0,
                ..
            })
        ));
    }

    #[test]
    fn rejects_wrong_kind_mode_link_count_and_size() {
        let temporary = TestDirectory::create();
        let uid = current_uid(&temporary.0);
        let path = temporary.0.join("leaf");
        fs::write(&path, b"bounded").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let descriptor = Descriptor::from_file(File::open(&path).unwrap());
        let base = DescriptorPolicy {
            kind: DescriptorKind::RegularFile,
            owner_uid: uid,
            exact_mode: 0o600,
            require_single_link: true,
            max_size: Some(7),
        };
        assert!(descriptor.validate(base).is_ok());
        assert_eq!(
            descriptor.validate(DescriptorPolicy {
                kind: DescriptorKind::Directory,
                ..base
            }),
            Err(DescriptorError::WrongKind)
        );
        assert_eq!(
            descriptor.validate(DescriptorPolicy {
                exact_mode: 0o400,
                ..base
            }),
            Err(DescriptorError::WrongMode)
        );
        assert_eq!(
            descriptor.validate(DescriptorPolicy {
                max_size: Some(6),
                ..base
            }),
            Err(DescriptorError::TooLarge)
        );
        fs::hard_link(&path, temporary.0.join("second-link")).unwrap();
        assert_eq!(
            descriptor.validate(base),
            Err(DescriptorError::WrongLinkCount)
        );
    }

    #[test]
    fn open_beneath_refuses_symlink_and_traversal() {
        let temporary = TestDirectory::create();
        let parent = Descriptor::from_file(File::open(&temporary.0).unwrap());
        fs::write(temporary.0.join("target"), b"data").unwrap();
        symlink("target", temporary.0.join("link")).unwrap();

        assert!(
            open_beneath(
                parent.as_fd(),
                c"target",
                OpenAccess::ReadOnly { directory: false }
            )
            .is_ok()
        );
        assert!(
            open_beneath(
                parent.as_fd(),
                c"link",
                OpenAccess::ReadOnly { directory: false }
            )
            .is_err()
        );
        assert_eq!(
            open_beneath(
                parent.as_fd(),
                c"../target",
                OpenAccess::ReadOnly { directory: false }
            )
            .unwrap_err(),
            crate::syscall::Errno::EINVAL
        );
    }
}
