//! What the writer reads off git, as `lib/craft-log-run.mjs` and `lib/repo-key.mjs` read it: one
//! probe at a time, its trimmed stdout, `""` when git fails or is missing — a field that cannot be
//! resolved is empty and never fails a write.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// git's trimmed stdout for `args` in `cwd`, `""` when it fails.
#[must_use]
pub fn git(args: &[&str], cwd: &Path) -> String {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0");
    match cmd.output() {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).trim().to_owned(),
        _ => String::new(),
    }
}

/// The run's branch and head in the working copy `dir`: no branch on a detached `HEAD`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GitId {
    pub branch: String,
    pub head: String,
}

/// `gitIdentity`.
#[must_use]
pub fn identity(dir: &Path) -> GitId {
    let branch = git(&["rev-parse", "--abbrev-ref", "HEAD"], dir);
    GitId {
        branch: if branch == "HEAD" {
            String::new()
        } else {
            branch
        },
        head: git(&["rev-parse", "HEAD"], dir),
    }
}

/// The repository as the store keys it (`repoKey`): the parent of a common git directory named
/// `.git` (a checkout and its linked worktrees share it), else the work tree's top level, else the
/// common directory, else the real path, else the path as given.
#[must_use]
pub fn repo_key(dir: &Path) -> PathBuf {
    let abs = std::path::absolute(dir).unwrap_or_else(|_| dir.to_path_buf());
    let common = git(
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        &abs,
    );
    let valid = !common.is_empty() && !common.contains('\n') && Path::new(&common).is_absolute();
    if valid
        && (common.ends_with("/.git") || common == ".git")
        && let Some(parent) = Path::new(&common).parent()
    {
        return lexical(parent);
    }
    let top = git(&["rev-parse", "--show-toplevel"], &abs);
    if !top.is_empty() {
        return lexical(Path::new(&top));
    }
    if valid {
        return lexical(Path::new(&common));
    }
    std::fs::canonicalize(&abs).unwrap_or(abs)
}

/// `path.resolve` of an absolute path: `.` and `..` applied, no symlink followed.
#[must_use]
pub fn lexical(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            c @ (std::path::Component::Prefix(_)
            | std::path::Component::RootDir
            | std::path::Component::Normal(_)) => out.push(c),
        }
    }
    out
}

/// `head` abbreviated as git abbreviates it in the repository at `git_dir`, `""` when it cannot.
#[must_use]
pub fn short_commit(git_dir: &Path, head: &str) -> String {
    let dir = git_dir.display().to_string();
    git(
        &["--git-dir", &dir, "rev-parse", "--short", head],
        Path::new("/"),
    )
}
