//! A store below a directory the user cannot search is unreadable, not absent: every `craft runs`
//! reader exits non-zero and names the path and the OS error, never an empty clean result (#450).
#![cfg(unix)]
#![expect(clippy::unwrap_used, reason = "fixtures fail loudly")]

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Restores the denied directory's permissions so the temporary directory can be removed.
struct Restore(PathBuf);

impl Drop for Restore {
    fn drop(&mut self) {
        drop(std::fs::set_permissions(
            &self.0,
            std::fs::Permissions::from_mode(0o755),
        ));
    }
}

fn craft(home: &Path, args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_craft"))
        .env("HOME", home)
        .current_dir(home)
        .args(args)
        .output()
        .unwrap()
}

#[test]
fn a_store_below_an_unsearchable_directory_is_an_error_for_every_reader() {
    let root = tempfile::tempdir().unwrap();
    let denied = root.path().join("denied");
    let store = denied.join("runs");
    std::fs::create_dir_all(&store).unwrap();
    std::fs::write(store.join("index.jsonl"), "").unwrap();
    std::fs::set_permissions(&denied, std::fs::Permissions::from_mode(0o000)).unwrap();
    let _restore = Restore(denied);
    if std::fs::metadata(&store).is_ok() {
        // Permissions are not enforced for this user (root, CAP_DAC_OVERRIDE): nothing to test.
        return;
    }
    let store_arg = store.to_str().unwrap();
    let project = root.path().to_str().unwrap();
    for sub in [
        &["recurring", "--project", project][..],
        &["ls"],
        &["show", "x"],
        &["stats"],
        &["check"],
        &["retro", "0.1.0"],
    ] {
        let mut args = vec!["runs", "--store", store_arg];
        args.extend_from_slice(sub);
        let out = craft(root.path(), &args);
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(
            !out.status.success(),
            "{sub:?} succeeded: {}",
            String::from_utf8_lossy(&out.stdout)
        );
        assert!(
            stderr.contains(store_arg),
            "{sub:?} names no path: {stderr}"
        );
        assert!(
            stderr.contains("Permission denied"),
            "{sub:?} names no OS error: {stderr}"
        );
    }
}
