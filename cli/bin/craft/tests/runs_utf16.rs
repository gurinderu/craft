//! The binary reads a file the public writer actually filed, including non-Unicode strings.

use std::process::Command;

use craft_store::git::GitId;
use craft_store::js::{Js, parse};
use craft_store::write::{Writing, write_record};

#[test]
fn show_and_json_listing_preserve_utf16_while_unicode_only_reports_refuse() {
    let dir = tempfile::tempdir().unwrap();
    let input = parse(r#"{"schemaVersion":1,"kind":"workflow","name":"\ud800","verdict":"Approve\udc00","\ud800":1,"\ud801":2,"�":3,"\\ud800":4,"nested":{"\udc00":["\ud801","😀"]}}"#).unwrap();
    let w = Writing {
        store: dir.path().to_path_buf(),
        project: "/p".into(),
        workdir: dir.path().to_path_buf(),
        session: String::new(),
        git_id: GitId::default(),
        observe: false,
        craft_commit: None,
        now: 0,
    };
    let (file, written) =
        write_record(input.as_obj().unwrap(), &w, &GitId::default(), None).unwrap();
    let run = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_craft"))
            .arg("runs")
            .args(args)
            .arg("--store")
            .arg(dir.path())
            .output()
            .unwrap()
    };
    let shown = run(&[
        "show",
        file.file_name().unwrap().to_str().unwrap(),
        "--json",
    ]);
    assert!(shown.status.success(), "{shown:?}");
    let text = String::from_utf8(shown.stdout).unwrap();
    assert_eq!(text.trim_end(), Js::Obj(written).compact());
    for field in [
        r#""\ud800":1"#,
        r#""\ud801":2"#,
        r#""�":3"#,
        r#""\\ud800":4"#,
    ] {
        assert!(text.contains(field), "{text}");
    }
    let listed = run(&["ls", "--json"]);
    assert!(listed.status.success(), "{listed:?}");
    assert!(
        String::from_utf8(listed.stdout)
            .unwrap()
            .contains(r#""verdict":"Approve\udc00""#)
    );
    for args in [&["ls"][..], &["stats", "--by", "name"][..]] {
        let refused = run(args);
        assert!(!refused.status.success(), "{refused:?}");
        assert!(
            String::from_utf8(refused.stderr)
                .unwrap()
                .contains("UTF-16")
        );
        assert!(refused.stdout.is_empty());
    }
}
