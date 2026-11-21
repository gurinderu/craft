use craft_store::js::{Js, parse};

use super::support::Store;

#[test]
fn unpaired_matching_fields_survive_and_never_collapse_into_replacement_characters() {
    let s = Store::new();
    for (i, branch) in [r"a\ud800", r"a\ud801"].iter().enumerate() {
        let raw = format!(
            r#"{{"project":{},"branch":" {branch} ","ts":"\ud800","unrelated":"\udfff","ledger":[
            {{"file":"src/\ud800.rs","title":"parser \ud800 panic","tier":"confirmed","severity":"\ud800"}},
            {{"file":"src/\ud801.rs","title":"parser \ud801 panic","tier":"confirmed","severity":"\ud801"}},
            {{"file":"src/�.rs","title":"parser � panic","tier":"confirmed","severity":"�"}},
            {{"file":"separate","title":"same","tier":"confirmed\ud800"}}
        ]}}"#,
            serde_json::to_string(&s.project).unwrap()
        );
        std::fs::write(s.store.join(format!("{i}.json")), raw).unwrap();
    }
    std::fs::write(
        s.store.join("other.json"),
        r#"{"project":"\ud800","branch":"b","ledger":[]}"#,
    )
    .unwrap();
    let out = s.output(&["--path", "src"]);
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let raw = String::from_utf8(out.stdout).unwrap();
    let result = parse(&raw).unwrap();
    let groups = result
        .as_obj()
        .unwrap()
        .get("groups")
        .unwrap()
        .as_arr()
        .unwrap();
    assert_eq!(
        result
            .as_obj()
            .unwrap()
            .get("skipped")
            .unwrap()
            .as_obj()
            .unwrap()
            .get("otherProject"),
        Some(&Js::Num(1.0))
    );
    assert_eq!(groups.len(), 3);
    let first = groups[0].as_obj().unwrap();
    assert_eq!(first.get("file").unwrap().compact(), r#""src/\ud800.rs""#);
    assert_eq!(
        first.get("branches").unwrap().compact(),
        r#"["a\ud800","a\ud801"]"#
    );
    assert_eq!(first.get("lastSeen").unwrap().compact(), r#""\ud800""#);
    assert_eq!(
        first.get("titles").unwrap().compact(),
        r#"["parser \ud800 panic"]"#
    );
    assert_eq!(first.get("severities").unwrap().compact(), r#"["\ud800"]"#);
    assert_eq!(
        result
            .as_obj()
            .unwrap()
            .get("skipped")
            .unwrap()
            .as_obj()
            .unwrap()
            .get("unreadable"),
        Some(&Js::Num(0.0))
    );
}

#[test]
fn malformed_utf8_is_decoded_like_node_without_discarding_valid_records() {
    let s = Store::new();
    for (i, branch) in ["a", "b"].iter().enumerate() {
        // The invalid byte goes only into `unrelated`: the project path is a
        // random temporary directory and may hold any ASCII letter.
        let head = format!(
            r#"{{"project":{},"branch":"{branch}","unrelated":""#,
            serde_json::to_string(&s.project).unwrap()
        );
        let tail = r#"","ledger":[{"file":"f","title":"same","tier":"confirmed"}]}"#;
        let bytes = [head.as_bytes(), &[0xff], tail.as_bytes()].concat();
        std::fs::write(s.store.join(format!("{i}.json")), bytes).unwrap();
    }
    assert_eq!(s.read(&[])["groups"].as_array().unwrap().len(), 1);
}
