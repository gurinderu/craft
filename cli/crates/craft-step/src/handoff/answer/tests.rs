use super::*;

fn aside_of(dir: &Path, stem: &str) -> Aside {
    Aside(vec![Marked {
        id: "t".into(),
        from: dir.join("t.json"),
        dir: dir.to_owned(),
        stem: stem.into(),
    }])
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
        matches!(failed.as_slice(), [Unmoved { id, error: HandoffError::Unmovable { path, .. } }] if id == "t" && *path == dir.join("t.json")),
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

#[test]
fn a_claimed_name_is_taken_at_once() {
    let d = tempfile::tempdir().unwrap();
    let dir = d.path();
    fs::write(dir.join("s.json"), "earlier").unwrap();
    let first = claim(dir, "s").unwrap();
    let second = claim(dir, "s").unwrap();
    assert_eq!(
        (first, second.clone()),
        (dir.join("s.1.json"), dir.join("s.2.json"))
    );
    assert_eq!(fs::read_to_string(&second).unwrap(), "");
    assert_eq!(fs::read_to_string(dir.join("s.json")).unwrap(), "earlier");
}

#[cfg(unix)]
#[test]
fn a_failed_rename_gives_the_claimed_name_back() {
    let d = tempfile::tempdir().unwrap();
    let dir = d.path();
    // A directory with something in it cannot be renamed over the claimed file.
    fs::create_dir(dir.join("t.json")).unwrap();
    fs::write(dir.join("t.json").join("x"), "").unwrap();
    let failed = aside_of(dir, "t.rejected-0").apply();
    assert!(
        matches!(
            failed.as_slice(),
            [Unmoved {
                error: HandoffError::Unmovable { .. },
                ..
            }]
        ),
        "{failed:?}"
    );
    assert!(!dir.join("t.rejected-0.json").exists());
    assert!(dir.join("t.json").join("x").is_file());
}

#[test]
fn an_answer_at_the_bound_is_read_and_one_over_it_refused_with_its_print() {
    let d = tempfile::tempdir().unwrap();
    let at = d.path().join("at.json");
    fs::write(&at, "[1, 2]").unwrap();
    let got = read_capped(&at, 6);
    assert_eq!(got.answer.unwrap(), serde_json::json!([1, 2]));
    let over = d.path().join("over.json");
    fs::write(&over, "[1, 2] ").unwrap();
    let got = read_capped(&over, 6);
    assert!(got.answer.unwrap_err().contains("holds over the 6 bytes"));
    let print = got.print.expect("printed, so known again in place");
    assert_eq!(read_capped(&over, 6).print, Some(print));
}

#[cfg(target_os = "linux")]
#[test]
fn a_file_reporting_no_size_is_still_read_only_to_the_bound() {
    // procfs reports a length of 0 for a file that holds far more.
    let got = read_capped(Path::new("/proc/self/status"), 8);
    assert!(got.answer.unwrap_err().contains("holds over the 8 bytes"));
}
