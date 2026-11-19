//! A change whose one consumer line a lens is shown.

use std::path::Path;

use super::git;

/// A repository whose change to `shared_target` has one consumer line, `src/user.rs:2`.
pub fn one_consumer(d: &Path) {
    git(d, &["init", "-q", "-b", "main"]);
    std::fs::create_dir_all(d.join("src")).unwrap();
    std::fs::write(
        d.join("src/lib.rs"),
        "pub fn shared_target() -> u8 {\n    1\n}\n",
    )
    .unwrap();
    let user = "pub fn user() -> u8 {\n    crate::shared_target()\n}\n";
    std::fs::write(d.join("src/user.rs"), user).unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "init"]);
    git(d, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    std::fs::write(
        d.join("src/lib.rs"),
        "pub fn shared_target() -> u8 {\n    2\n}\n",
    )
    .unwrap();
    git(d, &["commit", "-qam", "fix: return 2"]);
}
