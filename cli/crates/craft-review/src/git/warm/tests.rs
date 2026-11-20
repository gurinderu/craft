use std::time::{Duration, Instant};

use super::{fetch_diff_objects, read_diff};
use crate::cancel::{Cancel, STOPPED};
use crate::git::GitError;
use crate::git::tests::{blobless, git, missing};

#[test]
fn a_partial_clone_missing_the_bases_blobs_is_reviewed_once_craft_fetched_them() {
    let t = tempfile::tempdir().unwrap();
    let (clone, _remote) = blobless(t.path());
    assert_eq!(missing(&clone), 1);
    let cancel = Cancel::default();
    assert_eq!(
        fetch_diff_objects(&clone, Some("origin/base"), None, &cancel),
        Ok(true)
    );
    assert_eq!(missing(&clone), 0, "the base's blob was fetched");
    let diff = read_diff(&clone, Some("origin/base"), None, &cancel).unwrap();
    assert_eq!(diff.files, ["f"]);
    assert!(diff.stat.contains("1 file changed"), "{}", diff.stat);
}

#[test]
fn a_clone_that_is_not_partial_fetches_nothing_for_its_diff() {
    let t = tempfile::tempdir().unwrap();
    let (blobless_clone, remote) = blobless(t.path());
    drop(blobless_clone);
    let at = remote.display().to_string();
    git(t.path(), &["clone", "-q", &format!("file://{at}"), "full"]);
    let full = t.path().join("full");
    // No remote to reach: a fetch would fail.
    std::fs::rename(&remote, t.path().join("gone.git")).unwrap();
    let cancel = Cancel::default();
    assert_eq!(
        fetch_diff_objects(&full, Some("origin/base"), None, &cancel),
        Ok(false)
    );
    read_diff(&full, Some("origin/base"), None, &cancel).unwrap();
}

#[test]
fn a_partial_clone_whose_remote_is_gone_names_the_missing_objects_and_the_failed_fetch() {
    let t = tempfile::tempdir().unwrap();
    let (clone, remote) = blobless(t.path());
    std::fs::rename(&remote, t.path().join("gone.git")).unwrap();
    let began = Instant::now();
    let got = read_diff(&clone, Some("origin/base"), None, &Cancel::default());
    assert!(
        began.elapsed() < Duration::from_secs(10),
        "{:?}",
        began.elapsed()
    );
    let Err(e @ GitError::NotFetched { .. }) = &got else {
        panic!("{got:?}");
    };
    let said = e.to_string();
    assert!(said.contains("craft's fetch of them failed"), "{said}");
}

#[test]
fn a_stopped_run_fetches_nothing() {
    let t = tempfile::tempdir().unwrap();
    let (clone, _remote) = blobless(t.path());
    let cancel = Cancel::default();
    cancel.cancel();
    assert_eq!(
        fetch_diff_objects(&clone, Some("origin/base"), None, &cancel),
        Err(STOPPED.to_owned())
    );
    assert_eq!(missing(&clone), 1);
}
