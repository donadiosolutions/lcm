//! Fail-closed primitives for the LCM Linux daemon-restart helper.
//!
//! This crate deliberately does not implement restart orchestration. In particular, it exposes
//! no numeric-PID signaling API and no path-based fallback when a kernel capability is missing.

#![forbid(unsafe_op_in_unsafe_fn)]

#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
compile_error!("lcm-daemon-restart-helper supports only Linux x86_64");

pub mod capability;
pub mod descriptor;
pub mod protocol;
mod sha256;
pub mod syscall;
