use std::time::Duration;

use super::*;

fn runner(dir: &Path) -> Runner {
    Runner::new(Duration::from_secs(30), None, dir.join("out"))
}

#[test]
fn a_program_not_on_the_path_is_missing() {
    let d = tempfile::tempdir().unwrap();
    let ran = runner(d.path()).run(d.path(), "craft-no-such-tool", &[]);
    assert_eq!(ran, Ran::Missing);
}

#[test]
fn a_working_directory_that_is_gone_is_no_missing_program() {
    let d = tempfile::tempdir().unwrap();
    let gone = d.path().join("removed-worktree");
    let ran = runner(d.path()).run(&gone, "sh", &["-c", "true"]);
    let Ran::Broken(why) = ran else {
        panic!("{ran:?}");
    };
    assert!(why.contains("does not exist"), "{why}");
    assert!(why.contains("removed-worktree"), "{why}");
}
