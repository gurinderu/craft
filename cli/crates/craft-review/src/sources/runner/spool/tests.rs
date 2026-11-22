use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, PermissionsExt};

use super::{KEEP, Spool};

fn names(list: &[&str]) -> impl Iterator<Item = String> {
    list.iter()
        .map(|n| (*n).to_owned())
        .collect::<Vec<_>>()
        .into_iter()
}

fn left_in(dir: &std::path::Path) -> Vec<String> {
    let mut left: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    left.sort();
    left
}

#[cfg(unix)]
#[test]
fn a_spool_is_this_users_only_and_its_name_is_gone_at_once() {
    let d = tempfile::tempdir().unwrap();
    let (spool, _writer) = Spool::new_in(d.path(), &mut names(&["one"])).unwrap();
    let mode = spool.read.metadata().unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600);
    assert_eq!(left_in(d.path()), Vec::<String>::new());
}

#[test]
fn a_name_taken_already_is_passed_over_and_left_as_it_was() {
    let d = tempfile::tempdir().unwrap();
    std::fs::write(d.path().join("taken"), "someone else's").unwrap();
    let (mut spool, mut writer) = Spool::new_in(d.path(), &mut names(&["taken", "free"])).unwrap();
    writer.write_all(b"git's line\n").unwrap();
    assert_eq!(spool.text().unwrap(), "git's line\n");
    assert_eq!(left_in(d.path()), ["taken"]);
    assert_eq!(
        std::fs::read_to_string(d.path().join("taken")).unwrap(),
        "someone else's"
    );
}

#[test]
fn a_large_output_keeps_its_tail() {
    let d = tempfile::tempdir().unwrap();
    let (mut spool, mut writer) = Spool::new_in(d.path(), &mut names(&["big"])).unwrap();
    let keep = usize::try_from(KEEP).unwrap();
    writer.write_all(&vec![b'x'; keep]).unwrap();
    writer.write_all(b"the last line\n").unwrap();
    let text = spool.text().unwrap();
    assert_eq!(text.len(), keep);
    assert!(
        text.ends_with("the last line\n"),
        "{:?}",
        text.get(keep - 20..)
    );
}

#[cfg(unix)]
#[test]
fn the_reader_and_the_writer_are_one_file() {
    let d = tempfile::tempdir().unwrap();
    let (spool, writer) = Spool::new_in(d.path(), &mut names(&["one"])).unwrap();
    let (read, write) = (spool.read.metadata().unwrap(), writer.metadata().unwrap());
    assert_eq!((read.dev(), read.ino()), (write.dev(), write.ino()));
}

#[test]
fn a_whole_read_gives_all_of_it_and_refuses_past_its_cap_or_not_utf8() {
    let d = tempfile::tempdir().unwrap();
    let (mut spool, mut w) = Spool::new_in(d.path(), &mut names(&["w"])).unwrap();
    w.write_all(b"{\"rows\":[]}").unwrap();
    assert_eq!(spool.whole(64).unwrap(), "{\"rows\":[]}");
    let over = spool.whole(4).unwrap_err().to_string();
    assert!(over.contains("over 4 bytes"), "{over}");
    w.write_all(b"\xff").unwrap();
    assert_eq!(
        spool.whole(64).unwrap_err().kind(),
        std::io::ErrorKind::InvalidData
    );
}
