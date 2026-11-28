//! The notes a host keeps for the next submit: each once, nothing written for none, and an
//! unreadable file still read as a note.

use super::{file, forget, keep, kept};

fn notes(ns: &[&str]) -> Vec<String> {
    ns.iter().map(|n| (*n).to_owned()).collect()
}

#[test]
fn notes_kept_over_two_rounds_are_read_back_each_once_in_order() {
    let d = tempfile::tempdir().unwrap();
    keep(d.path(), &notes(&["round 1: a", "round 1: b"])).unwrap();
    keep(d.path(), &notes(&[" round 1: a\n", "round 2: c", ""])).unwrap();
    assert_eq!(kept(d.path()), ["round 1: a", "round 1: b", "round 2: c"]);
    assert!(!d.path().join("host-degraded.json.tmp").exists());
}

#[test]
fn no_note_writes_no_file() {
    let d = tempfile::tempdir().unwrap();
    keep(d.path(), &[]).unwrap();
    keep(d.path(), &notes(&["  ", ""])).unwrap();
    assert!(!file(d.path()).exists());
    assert!(kept(d.path()).is_empty());
}

#[test]
fn a_note_kept_already_leaves_the_file_as_it_was() {
    let d = tempfile::tempdir().unwrap();
    // Written compact, as `keep` never writes it: a rewrite would show.
    std::fs::write(file(d.path()), "[\"round 1: a\"]").unwrap();
    keep(d.path(), &notes(&["round 1: a"])).unwrap();
    assert_eq!(
        std::fs::read_to_string(file(d.path())).unwrap(),
        "[\"round 1: a\"]"
    );
}

#[test]
fn forgotten_notes_are_gone_and_forgetting_none_is_harmless() {
    let d = tempfile::tempdir().unwrap();
    forget(d.path());
    keep(d.path(), &notes(&["round 1: a"])).unwrap();
    forget(d.path());
    assert!(!file(d.path()).exists());
    assert!(kept(d.path()).is_empty());
}

#[test]
fn an_unreadable_file_is_read_as_a_note_saying_so() {
    let d = tempfile::tempdir().unwrap();
    std::fs::write(file(d.path()), "{bad").unwrap();
    let read = kept(d.path());
    assert_eq!(read.len(), 1, "{read:?}");
    assert!(
        read[0].contains("host-degraded.json could not be read")
            && read[0].contains("weaker than it reads"),
        "{read:?}"
    );
    std::fs::remove_file(file(d.path())).unwrap();
    std::fs::create_dir(file(d.path())).unwrap();
    assert_eq!(kept(d.path()).len(), 1, "a directory in its place too");
}

#[test]
fn a_file_that_cannot_be_written_is_an_error() {
    let d = tempfile::tempdir().unwrap();
    let gone = d.path().join("absent");
    assert!(keep(&gone, &notes(&["round 1: a"])).is_err());
}
