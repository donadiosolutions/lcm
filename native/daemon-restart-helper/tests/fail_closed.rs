use lcm_daemon_restart_helper::capability;
use std::process::Command;

#[test]
fn executable_stays_unwired_and_fails_closed_after_primitive_probe() {
    capability::probe().expect("test host must pass the helper's read-only primitive probe");
    let status = Command::new(env!("CARGO_BIN_EXE_daemon-restart-helper"))
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(78));
}
