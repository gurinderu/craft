//! Whether a shell command line acts on a system outside the checkout (realm @nick/craft, node
//! #620): each command of the line — split at pipes, `&&`, `||`, `;`, `$(…)` and backticks — read
//! past a prompt, environment assignments and wrappers (`sudo -u postgres`, `env`, `watch -n 5`,
//! `do`, `then`) to its program. A build or a package manager's command, which runs in the checkout
//! (`cargo`, `npm`, `nix build`, `docker build`), is no such step.

/// Programs whose every use acts on a cluster, a forge, a cloud, a database or a host.
#[rustfmt::skip]
const COMMANDS: &[&str] = &[
    "kubectl", "helm", "kustomize", "virtctl", "kubeadm", "flux", "argocd", "linstor", "oc",
    "terraform", "tofu", "pulumi", "ansible", "ansible-playbook", "gh", "glab", "psql", "pg_dump",
    "pg_restore", "mysql", "redis-cli", "mongosh", "etcdctl", "vault", "consul", "aws", "gcloud",
    "az", "doctl", "nixos-rebuild", "colmena", "ssh", "scp", "rsync", "systemctl", "journalctl",
];

/// Programs that act outside the checkout only through these subcommands.
const SUBCOMMANDS: &[(&str, &[&str])] = &[
    ("docker", &["push", "login", "exec"]),
    ("podman", &["push", "login", "exec"]),
    ("nix", &["copy"]),
    ("git", &["push"]),
];

/// Programs that act outside only when the command names a URL.
const FETCHERS: &[&str] = &["curl", "wget"];

/// Words that run the command after them, and words of shell syntax that open one.
#[rustfmt::skip]
const WRAPPERS: &[&str] = &[
    "$", "sudo", "env", "time", "watch", "nohup", "exec", "command", "xargs", "timeout", "do",
    "then", "else", "if", "while", "until", "!", "{",
];

/// Wrapper flags that take a value (`sudo -u postgres`, `watch -n 5`).
const VALUED: &[&str] = &["-u", "-g", "-n", "-i"];

/// Whether `line` holds a command acting on a system outside the checkout.
pub(super) fn runs_command(line: &str) -> bool {
    line.split(['|', '&', ';', '(', ')', '`']).any(acts_outside)
}

fn is_assignment(word: &str) -> bool {
    word.split_once('=').is_some_and(|(name, _)| {
        !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
    })
}

/// Whether the program of one command, past its wrappers, acts outside the checkout.
fn acts_outside(segment: &str) -> bool {
    let mut words = segment.split_whitespace();
    let mut wrapped = false;
    while let Some(w) = words.next() {
        if WRAPPERS.contains(&w) || is_assignment(w) {
            wrapped |= WRAPPERS.contains(&w);
            continue;
        }
        if wrapped && w.starts_with('-') {
            if VALUED.contains(&w) {
                words.next();
            }
            continue;
        }
        if w.ends_with('$') || (w.ends_with('#') && w.contains('@')) {
            continue; // a `user@host:~$` prompt
        }
        let program = w.rsplit('/').next().unwrap_or(w);
        return COMMANDS.contains(&program)
            || subcommand(program, words.next())
            || (FETCHERS.contains(&program) && segment.contains("://"));
    }
    false
}

fn subcommand(program: &str, next: Option<&str>) -> bool {
    SUBCOMMANDS
        .iter()
        .any(|(p, subs)| *p == program && next.is_some_and(|n| subs.contains(&n)))
}
