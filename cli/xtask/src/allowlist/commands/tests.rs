use super::super::line::check_line;
use super::{COMMANDS, argument, command};

#[test]
fn the_gate_s_commands_pass_and_nothing_else() {
    for c in COMMANDS {
        assert_eq!(command(c, true), Ok(c));
    }
    for word in [
        "tsc",
        "/usr/bin/node",
        "./node",
        "bash",
        "true",
        "trap",
        "timeout",
        "xargs",
        "builtin",
        "export",
        "hash",
    ] {
        assert!(
            command(word, true)
                .unwrap_err()
                .contains("is not one of the gate's commands"),
            "{word}"
        );
    }
    assert!(
        command("node", false)
            .unwrap_err()
            .contains("quoted or expanded")
    );
}

#[test]
fn every_listed_evasion_is_refused() {
    for line in [
        "trap 'exit 0' EXIT && knip",
        "X=1 sh -c 'knip || true'",
        "X=1 knip",
        "NODE_OPTIONS=--require=x node a.mjs",
        "timeout 600 bash -c knip",
        "xargs knip sh",
        "builtin eval knip",
        "export PATH=/x && knip",
        "hash -p /bin/true prettier && prettier --check .",
        "node -e 'process.exit(0)'",
        "node --eval=x",
        "node -p 1",
        "node --print 1",
        "node -r ./x a.mjs",
        "node --require ./x a.mjs",
        "node --import ./x a.mjs",
        "node -pe 1",
        "python3 -c 'pass'",
        "python3 -Bc 'pass'",
        "npx -c 'knip || true'",
        "npx --call 'knip || true'",
        "npm exec -c 'knip || true'",
        "knip && X=1",
    ] {
        assert!(check_line(line, false).is_err(), "{line}");
    }
}

#[test]
fn ordinary_arguments_pass() {
    for (c, word) in [
        ("node", "integrations/shared/build-engines.mjs"),
        ("node", "--check"),
        ("npx", "--yes"),
        ("npx", "@anthropic-ai/claude-code"),
        ("npm", "--prefix"),
        ("python3", "agent"),
        ("cargo", "-c"),
        ("knip", "--config=a"),
        ("node", "-"),
        ("node", "--"),
    ] {
        assert_eq!(argument(c, word), Ok(()), "{c} {word}");
    }
}

#[test]
fn an_environment_assignment_where_a_command_goes_is_named() {
    for word in ["X=1", "NODE_OPTIONS=--require=x", "_a=b", "PATH="] {
        assert!(
            command(word, true)
                .unwrap_err()
                .contains("environment assignment"),
            "{word}"
        );
    }
    assert!(
        command("a-b=1", true)
            .unwrap_err()
            .contains("is not one of")
    );
    assert!(
        check_line("NODE_OPTIONS=x node a.mjs", false)
            .unwrap_err()
            .contains("environment assignment")
    );
}
