//! Bounded non-mutating zero-session router helper entry point.

use lcm_daemon_restart_helper::invocation;
use std::process::ExitCode;

const EXIT_CAPABILITY_UNAVAILABLE: u8 = 69;
const EXIT_PROTOCOL_ENGINE_UNAVAILABLE: u8 = 78;

fn main() -> ExitCode {
    match invocation::serve_router() {
        invocation::OpenStableResult::Completed => ExitCode::SUCCESS,
        invocation::OpenStableResult::Unsupported => ExitCode::from(EXIT_CAPABILITY_UNAVAILABLE),
        invocation::OpenStableResult::Failed => ExitCode::from(EXIT_PROTOCOL_ENGINE_UNAVAILABLE),
    }
}
