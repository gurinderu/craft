use std::path::Path;
use std::process::Command;

use super::taken;

fn git(d: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .args(args)
        .current_dir(d)
        .status()
        .unwrap()
        .success();
    assert!(ok, "git {args:?}");
}

#[test]
fn a_change_whose_lines_cannot_be_read_takes_any_file_with_a_step_and_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    git(d, &["init", "-q", "-b", "main"]);
    std::fs::write(d.join("ops.md"), "```sh\nkubectl get pods\n```\n").unwrap();
    std::fs::write(d.join("README.md"), "# prose\n").unwrap();
    git(d, &["add", "."]);
    git(
        d,
        &[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-qm",
            "init",
        ],
    );
    let files = ["ops.md".to_owned(), "README.md".to_owned()];
    let got = taken(d, "0000000000000000000000000000000000000000", &files);
    assert_eq!(got.files.into_iter().collect::<Vec<_>>(), ["ops.md"]);
    assert_eq!(got.notes.len(), 1, "{:?}", got.notes);
    assert!(
        got.notes[0].contains("could not read the changed lines")
            && got.notes[0].contains("holding any step was given the runbook lens"),
        "{:?}",
        got.notes
    );
}
