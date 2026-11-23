//! The options the command reader steps over, as each tool's own help lists the ones taking a
//! separate value (sudo 1.9, GNU coreutils and findutils, procps watch, podman 5, Nix 2.35; docker
//! from its CLI reference). An option whose value is optional and only attached (`watch -d`,
//! `--differences=permanent`, `xargs --replace=R`, `env --block-signal=SIG`) takes no separate word,
//! nor does any `--opt=value`.

/// A word that runs the command after it: the options that take a separate value, and how many
/// positional words it takes before that command (`timeout`'s duration).
pub(super) struct Wrapper {
    pub name: &'static str,
    pub valued: &'static [&'static str],
    pub positional: usize,
}

const fn wrapper(name: &'static str, valued: &'static [&'static str]) -> Wrapper {
    Wrapper {
        name,
        valued,
        positional: 0,
    }
}

#[rustfmt::skip]
pub(super) const WRAPPERS: &[Wrapper] = &[
    wrapper("sudo", &[
        "-C", "--close-from", "-D", "--chdir", "-g", "--group", "--host", "-p", "--prompt", "-R",
        "--chroot", "-r", "--role", "-t", "--type", "-T", "--command-timeout", "-U", "--other-user",
        "-u", "--user",
    ]),
    wrapper("env", &["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
    wrapper("watch", &["-n", "--interval", "-q", "--equexit"]),
    Wrapper { name: "timeout", valued: &["-k", "--kill-after", "-s", "--signal"], positional: 1 },
    wrapper("xargs", &[
        "-a", "--arg-file", "-d", "--delimiter", "-E", "-I", "-L", "--max-lines", "-n",
        "--max-args", "-P", "--max-procs", "--process-slot-var", "-s", "--max-chars",
    ]),
    wrapper("nice", &["-n", "--adjustment"]),
    wrapper("time", &["-f", "--format", "-o", "--output"]),
    wrapper("exec", &["-a"]),
    wrapper("nohup", &[]), wrapper("command", &[]),
    // Shell syntax and a prompt, which open a command and take no option.
    wrapper("$", &[]), wrapper("do", &[]), wrapper("then", &[]), wrapper("else", &[]),
    wrapper("if", &[]), wrapper("while", &[]), wrapper("until", &[]), wrapper("!", &[]),
    wrapper("{", &[]),
];

/// A program acting outside the checkout only through some subcommands: its global options that
/// take separate values (with how many), and those subcommands.
pub(super) struct Subcommands {
    pub program: &'static str,
    pub globals: &'static [(&'static str, usize)],
    pub subs: &'static [&'static str],
}

#[rustfmt::skip]
const DOCKER: &[(&str, usize)] = &[
    ("--config", 1), ("-c", 1), ("--context", 1), ("-H", 1), ("--host", 1), ("-l", 1),
    ("--log-level", 1), ("--tlscacert", 1), ("--tlscert", 1), ("--tlskey", 1),
];
#[rustfmt::skip]
const PODMAN: &[(&str, usize)] = &[
    ("--cdi-spec-dir", 1), ("--cgroup-manager", 1), ("--config", 1), ("--conmon", 1), ("-c", 1),
    ("--connection", 1), ("--events-backend", 1), ("--hooks-dir", 1), ("--identity", 1),
    ("--imagestore", 1), ("--log-level", 1), ("--module", 1), ("--network-cmd-path", 1),
    ("--network-config-dir", 1), ("--out", 1), ("--root", 1), ("--runroot", 1), ("--runtime", 1),
    ("--runtime-flag", 1), ("--ssh", 1), ("--storage-driver", 1), ("--storage-opt", 1),
    ("--tls-ca", 1), ("--tls-cert", 1), ("--tls-key", 1), ("--tmpdir", 1), ("--url", 1),
    ("--volumepath", 1),
];
/// Nix's common options, and the settings every command takes as `--<setting> <value>`.
#[rustfmt::skip]
const NIX: &[(&str, usize)] = &[
    ("--log-format", 1), ("--option", 2), ("--extra-experimental-features", 1),
    ("--experimental-features", 1), ("--store", 1), ("--eval-store", 1), ("-I", 1),
    ("--include", 1), ("-j", 1), ("--max-jobs", 1), ("--cores", 1), ("--builders", 1),
];

pub(super) const SUBCOMMANDS: &[Subcommands] = &[
    Subcommands {
        program: "docker",
        globals: DOCKER,
        subs: &["push", "login", "exec"],
    },
    Subcommands {
        program: "podman",
        globals: PODMAN,
        subs: &["push", "login", "exec"],
    },
    Subcommands {
        program: "nix",
        globals: NIX,
        subs: &["copy"],
    },
];

/// How many words after `option` are its value: none for `--opt=value`.
pub(super) fn values(option: &str, valued: impl Fn(&str) -> Option<usize>) -> usize {
    if option.starts_with("--") && option.contains('=') {
        return 0;
    }
    valued(option).unwrap_or(0)
}
