//! Non-operational helper entry point.
//!
//! The executable performs only read-only inherited-descriptor admission. It exits unsuccessfully
//! in every case until the descriptor-owned state machine is implemented; it never signals a
//! process, launches a daemon, or changes recovery state.

use lcm_daemon_restart_helper::invocation;
use std::process::ExitCode;

const EXIT_CAPABILITY_UNAVAILABLE: u8 = 69;
const EXIT_PROTOCOL_ENGINE_UNAVAILABLE: u8 = 78;

fn main() -> ExitCode {
    match invocation::admit() {
        invocation::PreFrameResult::Unsupported => ExitCode::from(EXIT_CAPABILITY_UNAVAILABLE),
        // Ambiguous admission failures, as well as an admitted but deliberately unwired helper,
        // retain the protocol-engine-unavailable status without emitting a byte.
        invocation::PreFrameResult::Ambiguous | invocation::PreFrameResult::Admitted => {
            ExitCode::from(EXIT_PROTOCOL_ENGINE_UNAVAILABLE)
        }
    }
}
