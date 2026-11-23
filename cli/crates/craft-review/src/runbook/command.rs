//! Whether a shell command line acts on a system outside the checkout (realm @nick/craft, node
//! #620). No option is parsed — enumerating every tool's flags does not converge. The line is cut
//! into words at whitespace and shell punctuation (redirections too: `psql<<EOF`), each word stripped of its quotes, a leading
//! `$`/`#` and a directory, and the line is a step when any word is a known command anywhere on it
//! (`sudo -iu postgres psql`, `watch 'kubectl get pods'`, `sh -c 'systemctl restart x'`), when a
//! tool whose subcommand matters is followed anywhere later by one of its listed subcommands
//! (`nix --substituters https://x copy`), or when a fetcher names a URL. A false positive only runs
//! the lens once more; a false negative would skip a procedure silently. A build or a package
//! manager's command, which runs in the checkout (`cargo`, `npm`, `nix build`, `docker build`), is
//! no such step, nor is `git push` (a contributing guide's, not an operator's).

/// Programs whose every use acts on a cluster, a forge, a cloud, a database or a host.
#[rustfmt::skip]
const COMMANDS: &[&str] = &[
    "kubectl", "helm", "kustomize", "virtctl", "kubeadm", "flux", "argocd", "linstor", "oc",
    "terraform", "tofu", "pulumi", "ansible", "ansible-playbook", "gh", "glab", "psql", "pg_dump",
    "pg_restore", "mysql", "redis-cli", "mongosh", "etcdctl", "vault", "consul", "aws", "gcloud",
    "az", "doctl", "nixos-rebuild", "colmena", "deploy", "ssh", "scp", "rsync", "systemctl",
    "journalctl",
];

/// Tools that act outside the checkout only through these subcommands.
const SUBCOMMANDS: &[(&str, &[&str])] = &[
    ("docker", &["push", "login", "exec"]),
    ("podman", &["push", "login", "exec"]),
    ("nix", &["copy"]),
];

/// Programs that act outside only when the line names a URL.
const FETCHERS: &[&str] = &["curl", "wget"];

/// The words of `line`, each as a program would be named: quotes, a leading `$` or `#` and a
/// directory taken off.
fn words(line: &str) -> Vec<&str> {
    line.split(|c: char| {
        c.is_whitespace() || matches!(c, '|' | '&' | ';' | '(' | ')' | '`' | '<' | '>')
    })
    .map(|w| w.trim_matches(['"', '\'']).trim_start_matches(['$', '#']))
    .map(|w| w.rsplit('/').next().unwrap_or(w))
    .filter(|w| !w.is_empty())
    .collect()
}

/// Whether `line` holds a command acting on a system outside the checkout.
pub(super) fn runs_command(line: &str) -> bool {
    let words = words(line);
    words.iter().enumerate().any(|(at, w)| {
        COMMANDS.contains(w)
            || (FETCHERS.contains(w) && line.contains("://"))
            || SUBCOMMANDS.iter().any(|(tool, subs)| {
                tool == w && words.iter().skip(at + 1).any(|later| subs.contains(later))
            })
    })
}

#[cfg(test)]
#[path = "command_tests.rs"]
mod tests;
