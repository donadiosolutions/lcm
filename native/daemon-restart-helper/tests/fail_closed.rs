use std::process::Command;

#[test]
fn incomplete_inherited_abi_refuses_silently_with_ambiguous_exit_status() {
    let output = Command::new(env!("CARGO_BIN_EXE_daemon-restart-helper"))
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(78));
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
}
