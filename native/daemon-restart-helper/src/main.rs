//! Non-operational helper entry point.
//!
//! The executable performs only the read-only kernel admission probe. It exits unsuccessfully in
//! every case until the descriptor-owned state machine is implemented; it never signals a process,
//! launches a daemon, or changes recovery state.

use lcm_daemon_restart_helper::capability;
use std::process::ExitCode;

const EXIT_CAPABILITY_UNAVAILABLE: u8 = 69;
const EXIT_PROTOCOL_ENGINE_UNAVAILABLE: u8 = 78;

fn main() -> ExitCode {
    match capability::probe() {
        Ok(_) => ExitCode::from(EXIT_PROTOCOL_ENGINE_UNAVAILABLE),
        Err(_) => ExitCode::from(EXIT_CAPABILITY_UNAVAILABLE),
    }
}
