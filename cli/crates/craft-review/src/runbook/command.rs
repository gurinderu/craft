//! Whether a shell command line acts on a system outside the checkout (realm @nick/craft, node
//! #620): each command of the line — split at pipes, `&&`, `||`, `;`, `$(…)` and backticks — read
//! past a prompt, environment assignments and wrappers, each with its own options (`sudo -n`,
//! `sudo -u postgres`, `watch -n 5`, `timeout 30`, `xargs -I {}`), to its program, and past the
//! program's global options to its subcommand (`docker --context prod exec`). A build or a package
//! manager's command, which runs in the checkout (`cargo`, `npm`, `nix build`, `docker build`), is
//! no such step, nor is `git push` (a contributing guide's, not an operator's).

use std::iter::Peekable;
use std::str::SplitWhitespace;

/// Programs whose every use acts on a cluster, a forge, a cloud, a database or a host.
#[rustfmt::skip]
const COMMANDS: &[&str] = &[
    "kubectl", "helm", "kustomize", "virtctl", "kubeadm", "flux", "argocd", "linstor", "oc",
    "terraform", "tofu", "pulumi", "ansible", "ansible-playbook", "gh", "glab", "psql", "pg_dump",
    "pg_restore", "mysql", "redis-cli", "mongosh", "etcdctl", "vault", "consul", "aws", "gcloud",
    "az", "doctl", "nixos-rebuild", "colmena", "deploy", "ssh", "scp", "rsync", "systemctl",
    "journalctl",
];

/// A program's global options that take values (with how many), and the subcommands through which
/// alone it acts outside the checkout.
type Subcommands = (
    &'static str,
    &'static [(&'static str, usize)],
    &'static [&'static str],
);

const DOCKER_GLOBALS: &[(&str, usize)] = &[
    ("--context", 1),
    ("-c", 1),
    ("--host", 1),
    ("-H", 1),
    ("--config", 1),
    ("--log-level", 1),
];
const SUBCOMMANDS: &[Subcommands] = &[
    ("docker", DOCKER_GLOBALS, &["push", "login", "exec"]),
    ("podman", DOCKER_GLOBALS, &["push", "login", "exec"]),
    (
        "nix",
        &[
            ("--extra-experimental-features", 1),
            ("--experimental-features", 1),
            ("--store", 1),
            ("--option", 2),
        ],
        &["copy"],
    ),
];

/// Programs that act outside only when the command names a URL.
const FETCHERS: &[&str] = &["curl", "wget"];

/// A word that runs the command after it: its options that take a value, and how many positional
/// words it takes before that command (`timeout`'s duration).
type Wrapper = (&'static str, &'static [&'static str], usize);

#[rustfmt::skip]
const WRAPPERS: &[Wrapper] = &[
    ("sudo", &["-u", "-g", "-h", "-p", "-C", "-U", "-D", "-r", "-t", "-T"], 0),
    ("env", &["-u", "-C", "-S"], 0),
    ("watch", &["-n", "-d"], 0),
    ("timeout", &["-s", "-k"], 1),
    ("xargs", &["-I", "-n", "-L", "-P", "-d", "-E", "-s", "-a"], 0),
    ("nice", &["-n"], 0),
    ("time", &[], 0), ("nohup", &[], 0), ("exec", &[], 0), ("command", &[], 0),
    // Shell syntax and a prompt, which open a command and take no option.
    ("$", &[], 0), ("do", &[], 0), ("then", &[], 0), ("else", &[], 0), ("if", &[], 0),
    ("while", &[], 0), ("until", &[], 0), ("!", &[], 0), ("{", &[], 0),
];

type Words<'a> = Peekable<SplitWhitespace<'a>>;

/// Whether `line` holds a command acting on a system outside the checkout.
pub(super) fn runs_command(line: &str) -> bool {
    line.split(['|', '&', ';', '(', ')', '`']).any(acts_outside)
}

fn is_assignment(word: &str) -> bool {
    word.split_once('=').is_some_and(|(name, _)| {
        !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
    })
}

/// A `user@host:~$` or `host#` prompt word.
fn is_prompt(word: &str) -> bool {
    word.ends_with('$') || (word.ends_with('#') && word.contains('@'))
}

/// Takes `wrapper`'s options and positional words off `words`.
fn skip_wrapper((_, valued, positional): &Wrapper, words: &mut Words<'_>) {
    let mut positional = *positional;
    while let Some(next) = words.peek().copied() {
        if next.starts_with('-') && next != "-" {
            words.next();
            if valued.contains(&next) {
                words.next();
            }
        } else if positional > 0 {
            positional -= 1;
            words.next();
        } else {
            break;
        }
    }
}

/// Whether the program of one command, past its wrappers, acts outside the checkout.
fn acts_outside(segment: &str) -> bool {
    let mut words: Words<'_> = segment.split_whitespace().peekable();
    while let Some(w) = words.next() {
        if is_assignment(w) || is_prompt(w) {
            continue;
        }
        if let Some(wrapper) = WRAPPERS.iter().find(|(name, ..)| *name == w) {
            skip_wrapper(wrapper, &mut words);
            continue;
        }
        let program = w.rsplit('/').next().unwrap_or(w);
        return COMMANDS.contains(&program)
            || subcommand(program, &mut words)
            || (FETCHERS.contains(&program) && segment.contains("://"));
    }
    false
}

/// Whether `program`'s subcommand, past its global options, is one acting outside the checkout.
fn subcommand(program: &str, words: &mut Words<'_>) -> bool {
    let Some((_, globals, subs)) = SUBCOMMANDS.iter().find(|(p, ..)| *p == program) else {
        return false;
    };
    while let Some(w) = words.next() {
        if !w.starts_with('-') {
            return subs.contains(&w);
        }
        let takes = globals.iter().find(|(g, _)| *g == w).map_or(0, |(_, n)| *n);
        for _ in 0..takes {
            words.next();
        }
    }
    false
}
