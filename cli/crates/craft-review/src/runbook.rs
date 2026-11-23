//! The runbook signal (realm @nick/craft, node #620): a changed Markdown file that carries operator
//! steps — a shell block, or a numbered procedure, whose lines run a command against an external
//! system — goes to the `runbook` profile and its lens instead of being left out as prose. A line
//! heuristic, not a Markdown parser: it reads the file as the working tree holds it.

use std::path::Path;

/// Commands that act on a system outside the checkout: a cluster, a forge, a cloud, a database, a
/// host. A build or a package manager's command (`cargo`, `npm`) runs in the checkout and is left out.
#[rustfmt::skip]
const COMMANDS: &[&str] = &[
    "kubectl", "helm", "kustomize", "virtctl", "kubeadm", "flux", "argocd", "linstor", "oc",
    "terraform", "tofu", "pulumi", "ansible", "ansible-playbook", "gh", "glab", "curl", "wget",
    "psql", "pg_dump", "pg_restore", "mysql", "redis-cli", "mongosh", "etcdctl", "vault", "consul",
    "aws", "gcloud", "az", "doctl", "nix", "nixos-rebuild", "colmena", "deploy", "docker", "podman",
    "ssh", "scp", "rsync", "systemctl", "journalctl",
];

/// The info strings of a fenced block that holds shell; an empty one counts too.
const SHELLS: &[&str] = &["sh", "bash", "shell", "console", "zsh", "shell-session"];

/// Whether `line`, a prompt (`$ `, `# `) and a `sudo` stripped, opens with one of [`COMMANDS`].
fn runs_command(line: &str) -> bool {
    let mut line = line.trim_start();
    for prompt in ["$ ", "# ", "sudo "] {
        line = line.strip_prefix(prompt).unwrap_or(line).trim_start();
    }
    let word = line
        .split(|c: char| c.is_whitespace() || c == ';')
        .next()
        .unwrap_or("");
    COMMANDS.contains(&word)
}

/// A fence's opening (```` ``` ```` or `~~~`) and its info string's first word, lower-cased.
fn fence(line: &str) -> Option<(&str, String)> {
    let t = line.trim_start();
    let mark = ["```", "~~~"].into_iter().find(|m| t.starts_with(m))?;
    let info = t.trim_start_matches(mark.chars().next()?).trim();
    let word = info.split([' ', '{', ',']).next().unwrap_or("");
    Some((mark, word.to_lowercase()))
}

/// Whether `line` is a numbered step (`1.`, `2)`) holding an inline code span that runs a command.
fn numbered_step(line: &str) -> bool {
    let t = line.trim_start();
    let digits = t.bytes().take_while(u8::is_ascii_digit).count();
    let rest = t.get(digits..).unwrap_or("");
    if digits == 0 || !(rest.starts_with(". ") || rest.starts_with(") ")) {
        return false;
    }
    rest.split('`').skip(1).step_by(2).any(runs_command)
}

/// Whether Markdown `text` carries operator steps: a fenced block whose info string is a shell or
/// empty holding a line that runs one of [`COMMANDS`], or a numbered step whose inline code does.
#[must_use]
pub(crate) fn carries_steps(text: &str) -> bool {
    let mut open: Option<(&str, bool)> = None;
    for line in text.lines() {
        match open {
            Some((mark, shell)) => {
                if line.trim_start().starts_with(mark) {
                    open = None;
                } else if shell && runs_command(line) {
                    return true;
                }
            }
            None => {
                if let Some((mark, word)) = fence(line) {
                    open = Some((mark, word.is_empty() || SHELLS.contains(&word.as_str())));
                } else if numbered_step(line) {
                    return true;
                }
            }
        }
    }
    false
}

/// Whether `file` is Markdown, by its extension.
#[must_use]
pub(crate) fn is_markdown(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown")
}

/// What decides, for a changed file, whether it carries operator steps: a Markdown file under `top`
/// read from the working tree. A file that is not Markdown or cannot be read (deleted) carries none.
pub(crate) fn reader(top: &Path) -> impl Fn(&str) -> bool + '_ {
    move |file: &str| {
        is_markdown(file)
            && std::fs::read_to_string(top.join(file)).is_ok_and(|t| carries_steps(&t))
    }
}

#[cfg(test)]
mod tests;
