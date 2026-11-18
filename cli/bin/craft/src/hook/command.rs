//! Whether a shell command opens a pull request: one of its simple commands is `gh pr create` (or
//! its alias `gh pr new`, `-R`/`--repo` allowed before `pr`), reached through `env`, `sudo`,
//! `NAME=value` assignments, `rtk` and the shell's keywords, and not asking for `-h`/`--help`. The
//! command is split as the shell would ([`super::split`]), so `gh pr create` inside a quoted
//! argument, a comment or a heredoc is text. The `cd`s before it move the directory the pull
//! request is opened from, a subshell's only inside it; a git command before it that moves HEAD or
//! the index makes the head it will open unknowable now.

use std::path::{Path, PathBuf};

use super::prefix::{after_prefixes, options};
use super::split::{Piece, pieces};

/// A `gh pr create` the command runs.
#[derive(Debug, PartialEq, Eq)]
pub struct PrCreate {
    /// The directory it runs in, or why that cannot be told before the command runs.
    pub dir: Result<PathBuf, String>,
    /// The branch `--head`/`-H` names, its `<owner>:` taken off.
    pub head: Option<String>,
    /// An earlier git command of the chain that moves HEAD or the index, as `git <sub>`.
    pub moved_by: Option<String>,
}

/// The `gh pr create` that `command` runs from `cwd`, if it runs one.
pub fn pr_create(command: &str, cwd: &Path, home: Option<&Path>) -> Option<PrCreate> {
    let mut dir: Result<PathBuf, String> = Ok(cwd.to_path_buf());
    let (mut outer, mut moved_by) = (Vec::new(), None);
    for piece in pieces(command) {
        let words = match piece {
            Piece::Open => {
                outer.push(dir.clone());
                continue;
            }
            Piece::Close => {
                dir = outer.pop().unwrap_or(dir);
                continue;
            }
            Piece::Words(w) => w,
        };
        let run = after_prefixes(&words);
        if let Some(Opened { head }) = pr_create_args(run) {
            return Some(PrCreate {
                dir,
                head,
                moved_by,
            });
        }
        moved_by = moved_by.or_else(|| mover(run));
        if let Some(to) = cd_target(run, home) {
            dir = match (dir, to) {
                (_, Ok(p)) if p.is_absolute() => Ok(p),
                (Ok(d), Ok(p)) => Ok(d.join(p)),
                (Err(e), _) | (_, Err(e)) => Err(e),
            };
        }
    }
    None
}

/// A `gh pr create`'s arguments the check reads: the branch `--head` names.
struct Opened {
    head: Option<String>,
}

/// The arguments when `words` are `gh pr create`/`gh pr new` not asking for help.
fn pr_create_args(words: &[String]) -> Option<Opened> {
    let (gh, rest) = words.split_first()?;
    let rest = rest.get(options(rest, &["-R", "--repo"])..)?;
    let (pr, rest) = rest.split_first()?;
    let (create, args) = rest.split_first()?;
    let opens = gh == "gh" && pr == "pr" && (create == "create" || create == "new");
    if !opens || args.iter().any(|w| w == "-h" || w == "--help") {
        return None;
    }
    let head = head_flag(args).map(|b| b.rsplit(':').next().unwrap_or(b).to_owned());
    Some(Opened { head })
}

fn head_flag(args: &[String]) -> Option<&str> {
    args.iter().enumerate().find_map(|(i, w)| match w.as_str() {
        "--head" | "-H" => args.get(i + 1).map(String::as_str),
        w => w
            .strip_prefix("--head=")
            .or_else(|| w.strip_prefix("-H").filter(|b| !b.is_empty())),
    })
}

/// The git subcommands that move HEAD or the index.
const MOVERS: &[&str] = &[
    "commit",
    "checkout",
    "switch",
    "reset",
    "merge",
    "rebase",
    "pull",
    "cherry-pick",
    "am",
    "revert",
    "stash",
];

/// `git <sub>` when `words` run a git subcommand that moves HEAD or the index.
fn mover(words: &[String]) -> Option<String> {
    let (git, rest) = words.split_first()?;
    let sub = rest
        .get(
            options(
                rest,
                &["-C", "-c", "--git-dir", "--work-tree", "--namespace"],
            )..,
        )?
        .first()?;
    (git == "git" && MOVERS.contains(&sub.as_str())).then(|| format!("git {sub}"))
}

/// Where a `cd` or `pushd` goes: its argument, `~` read as `home`, `home` for a bare one; why it
/// cannot be told for `cd -`, `popd` and a shell expansion.
fn cd_target(words: &[String], home: Option<&Path>) -> Option<Result<PathBuf, String>> {
    let (cd, rest) = words.split_first()?;
    match cd.as_str() {
        "cd" | "pushd" => {}
        "popd" => {
            return Some(Err(
                "`popd` goes back to a directory the hook cannot see".into()
            ));
        }
        _ => return None,
    }
    let to = rest.get(options(rest, &[])..).and_then(<[String]>::first);
    Some(match (to.map(String::as_str), home) {
        (None, Some(home)) => Ok(home.to_path_buf()),
        (None, None) => Err(format!("a bare `{cd}` goes to HOME, which is not set")),
        (Some("-"), _) => Err(format!(
            "`{cd} -` goes back to a directory the hook cannot see"
        )),
        (Some(to), _) if to.contains(['$', '`']) => Err(format!(
            "`{cd} {to}` goes to a shell expansion the hook cannot resolve"
        )),
        (Some(to), home) => Ok(tilde(to, home)),
    })
}

fn tilde(to: &str, home: Option<&Path>) -> PathBuf {
    match (to.strip_prefix('~'), home) {
        (Some(rest), Some(home)) if rest.is_empty() || rest.starts_with('/') => {
            home.join(rest.trim_start_matches('/'))
        }
        _ => PathBuf::from(to),
    }
}

#[cfg(test)]
#[path = "command_tests.rs"]
mod tests;
