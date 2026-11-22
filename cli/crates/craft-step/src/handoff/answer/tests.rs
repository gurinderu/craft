use super::*;

fn aside_of(dir: &Path, stem: &str) -> Aside {
    Aside(vec![(dir.join("t.json"), dir.to_owned(), stem.into())])
}

#[test]
fn a_taken_name_is_never_overwritten() {
    let d = tempfile::tempdir().unwrap();
    let dir = answers_dir(d.path());
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("t.rejected-0.json"), "first").unwrap();
    fs::write(dir.join("t.json"), "second").unwrap();
    assert!(aside_of(&dir, "t.rejected-0").apply().is_empty());
    assert_eq!(
        fs::read_to_string(dir.join("t.rejected-0.json")).unwrap(),
        "first"
    );
    assert_eq!(
        fs::read_to_string(dir.join("t.rejected-0.1.json")).unwrap(),
        "second"
    );
    assert!(!dir.join("t.json").exists());
}

#[test]
fn every_name_taken_leaves_the_file_and_says_so() {
    let d = tempfile::tempdir().unwrap();
    let dir = d.path();
    fs::write(dir.join("t.rejected-0.json"), "0").unwrap();
    for n in 1..=SLOTS {
        fs::write(dir.join(format!("t.rejected-0.{n}.json")), n.to_string()).unwrap();
    }
    fs::write(dir.join("t.json"), "new").unwrap();
    let failed = aside_of(dir, "t.rejected-0").apply();
    assert!(
        matches!(failed.as_slice(), [HandoffError::Unmovable { path, .. }] if *path == dir.join("t.json")),
        "{failed:?}"
    );
    assert_eq!(fs::read_to_string(dir.join("t.json")).unwrap(), "new");
    assert_eq!(
        fs::read_to_string(dir.join(format!("t.rejected-0.{SLOTS}.json"))).unwrap(),
        SLOTS.to_string()
    );
}

#[test]
fn a_file_gone_already_is_no_failure() {
    let d = tempfile::tempdir().unwrap();
    assert!(aside_of(d.path(), "t.rejected-0").apply().is_empty());
    assert!(!d.path().join("t.rejected-0.json").exists());
}
