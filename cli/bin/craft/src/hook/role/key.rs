//! The repo's key as run records spell `project` (realm @nick/craft, #283): the one `repoKey` of
//! `lib/repo-key.mjs`, as `craft hook pr-opened` reads it too, with each git call bounded for a
//! hook.

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use super::js;
use crate::hook::{bounded, repo};

/// The bound on each git call a hook makes, well inside its 10 s.
const GIT_LIMIT: Duration = Duration::from_millis(800);

/// git's trimmed answer in `dir`, bounded for a hook; `None` when it fails or is empty.
fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(dir);
    craft_review::cancel::detached(&mut cmd);
    let out = bounded::output(cmd, GIT_LIMIT).ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    (out.status.success() && !text.is_empty()).then_some(text)
}

/// The repo's key as run records spell `project` (#283).
pub fn repo_key(root: &Path) -> String {
    let common = git(
        root,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    );
    repo::key_of(root, common, || {
        git(root, &["rev-parse", "--show-toplevel"]).map(|t| js::resolve(Path::new(&t)))
    })
}
