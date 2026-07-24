# Command-line behavior

LCM uses its own help renderer so every command has consistent usage,
options, and examples.

Use `lcm --help` for the complete command list and
`lcm <command> --help` for command-specific help. Commands grouped under
`daemon`, `config`, `machine`, `project`, `events`, and `connectors` use the parent command's
help page:

```bash
lcm daemon start --help
lcm config set --help
lcm machine recover --help
lcm project link --help
lcm connectors install --help
```

Nested help is resolved before command execution. A help request therefore
never starts the daemon, changes a machine or project identity, installs or removes
a connector, or performs another command action.

An unknown command writes an error and the complete command list to the
terminal, completes both outputs, and then exits with status 1.
