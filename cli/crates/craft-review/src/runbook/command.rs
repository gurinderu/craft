//! Whether a shell command line acts on a system outside the checkout (realm @nick/craft, node
//! #620): each command of the line — split at pipes, `&&`, `||`, `;`, `$(…)` and backticks — read
//! past a prompt, environment assignments and wrappers, each with its own options (`sudo -n`,
//! `sudo -u postgres`, `watch -n 5`, `timeout 30`, `xargs -I {}`), to its program, and past the
//! program's global options to its subcommand (`docker --context prod exec`). A build or a package
//! manager's command, which runs in the checkout (`cargo`, `npm`, `nix build`, `docker build`), is
//! no such step, nor is `git push` (a contributing guide's, not an operator's).

use std::iter::Peekable;
use std::str::SplitWhitespace;

use super::options::{SUBCOMMANDS, WRAPPERS, Wrapper, values};

/// Programs whose every use acts on a cluster, a forge, a cloud, a database or a host.
#[rustfmt::skip]
const COMMANDS: &[&str] = &[
    "kubectl", "helm", "kustomize", "virtctl", "kubeadm", "flux", "argocd", "linstor", "oc",
    "terraform", "tofu", "pulumi", "ansible", "ansible-playbook", "gh", "glab", "psql", "pg_dump",
    "pg_restore", "mysql", "redis-cli", "mongosh", "etcdctl", "vault", "consul", "aws", "gcloud",
    "az", "doctl", "nixos-rebuild", "colmena", "deploy", "ssh", "scp", "rsync", "systemctl",
    "journalctl",
];

/// Programs that act outside only when the command names a URL.
const FETCHERS: &[&str] = &["curl", "wget"];

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

/// Takes `wrapper`'s options (a bare `-` among them, `env`'s) and positional words off `words`.
fn skip_wrapper(wrapper: &Wrapper, words: &mut Words<'_>) {
    let mut positional = wrapper.positional;
    while let Some(next) = words.peek().copied() {
        if next.starts_with('-') {
            words.next();
            let n = values(next, |o| wrapper.valued.contains(&o).then_some(1));
            for _ in 0..n {
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
        if let Some(wrapper) = WRAPPERS.iter().find(|x| x.name == w) {
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
    let Some(p) = SUBCOMMANDS.iter().find(|x| x.program == program) else {
        return false;
    };
    while let Some(w) = words.next() {
        if !w.starts_with('-') {
            return p.subs.contains(&w);
        }
        let n = values(w, |o| {
            p.globals.iter().find(|(g, _)| *g == o).map(|(_, n)| *n)
        });
        for _ in 0..n {
            words.next();
        }
    }
    false
}
