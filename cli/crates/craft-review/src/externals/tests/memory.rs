use super::{import, json, put};
use craft_store::js::{self, Js};
use serde_json::json;

#[test]
fn structural_refusals_precede_reads_and_failed_reads_keep_slots_and_names() {
    let root = tempfile::tempdir().unwrap();
    let mut records = vec![
        json!({"kind":"rule"}),
        json!({"system":"s0","repo":"r","versionFrom":"gone","versionMatch":"(v1)"}),
        json!({"system":"s0","repo":"r","version":"v1"}),
        json!({"system":"gone","repo":"r","version":"v1","status":"withdrawn"}),
        json!(null),
        json!({"system":"bad","repo":"r","version":"v1","versionFrom":"f"}),
    ];
    for i in 1..9 {
        records.push(
            json!({"system":format!("s{i}"),"repo":"r","versionFrom":"gone","versionMatch":"(v1)"}),
        );
    }
    let result = import(root.path(), json!(records));
    assert_eq!(result["candidates"], json!([]));
    let refused = result["refused"].as_array().unwrap();
    assert_eq!(
        refused[0],
        "external record #1 (s0): a second record of the same system"
    );
    assert_eq!(refused[1], "external record #2 (gone): status withdrawn");
    assert_eq!(
        refused[2],
        "external record #3: no system name of letters, digits, `.`, `_` or `-`"
    );
    assert_eq!(
        refused[3],
        "external record #4 (bad): versionMatch missing or over 300 characters"
    );
    assert_eq!(
        refused[4],
        "external record #12 (s8): past the bound of 8 systems"
    );
    assert_eq!(refused[5], "external record s0: versionFrom gone not found");
    assert_eq!(refused.len(), 13);
}

#[test]
fn imports_file_precedence_stated_branches_trim_and_weak_repo_and_scope() {
    let root = tempfile::tempdir().unwrap();
    put(
        root.path(),
        "v",
        "tag: v1.13.2\npair: v2-v2\nidentity: qv3\n",
    );
    let result = import(
        root.path(),
        json!([
            {"system":" a ","repo":" r ","scope":" ../anything ","version":"ignored","versionFrom":"v","versionMatch":"(?<=tag: )(v[0-9.]+)(?=\\s|$)"},
            {"system":"b","repo":"ssh://git@h/a","versionFrom":"v","versionMatch":"^pair: (v[0-9.]+)-\\1$"},
            {"system":"c","repo":"bad","versionFrom":"v","versionMatch":"^identity: \\q(v[0-9.]+)$"},
            {"system":"stated","repo":"r","version":"\u{feff}release/1.2\u{feff}","status":7}
        ]),
    );
    assert_eq!(result["refused"], json!([]));
    let candidates = result["candidates"].as_array().unwrap();
    assert_eq!(
        candidates
            .iter()
            .map(|c| c["ref"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["v1.13.2", "v2", "v3", "release/1.2"]
    );
    assert_eq!(candidates[0]["scope"], "../anything");
    assert_eq!(candidates[0]["repo"], "r");
    assert!(candidates[0].get("version").is_none());
}

#[test]
fn kind_presence_differs_from_known_filter_and_utf16_fields_are_not_narrowed() {
    let root = tempfile::tempdir().unwrap();
    let value = js::parse(r#"[{"kind":null},{"kind":""},null,[],{"system":"a","repo":"\ud800","scope":"\udfff","version":"v1"},{"system":"b","status":"\ud800"}]"#).unwrap();
    let result = super::super::import(root.path(), &value).unwrap();
    assert!(result.compact().contains(r#""repo":"\ud800""#));
    assert!(result.compact().contains(r#""scope":"\udfff""#));
    assert!(
        result
            .compact()
            .contains(r"external record #3 (b): status \ud800")
    );
    let mut expected = result;
    if let Js::Obj(o) = &mut expected {
        o.remove("candidates");
        o.remove("refused");
    }
    assert_eq!(json(expected), json!({}));
}

#[test]
fn text_caps_are_utf16_not_bytes_and_capture_refusals_keep_utf16_prefix() {
    let root = tempfile::tempdir().unwrap();
    let result = import(
        root.path(),
        json!([
            {"system":"a","repo":"😀".repeat(150),"version":"v1"},
            {"system":"b","repo":"😀".repeat(151),"version":"v1"},
            {"system":"c","repo":"r","version":"é".repeat(100)}
        ]),
    );
    assert_eq!(result["candidates"].as_array().unwrap().len(), 1);
    assert_eq!(
        result["refused"][0],
        "external record #1 (b): repo missing or over 300 characters"
    );
    assert_eq!(
        result["refused"][1],
        "external record c: version: revision outside [A-Za-z0-9._+/-] or starting with a non-alphanumeric"
    );
}

#[test]
fn a_catastrophically_backtracking_version_match_is_refused_for_its_record_not_a_hang() {
    let root = tempfile::tempdir().unwrap();
    put(root.path(), "v", &format!("{}!\n", "a".repeat(40)));
    put(root.path(), "w", "tag: v1\n");
    let started = std::time::Instant::now();
    let result = import(
        root.path(),
        json!([
            {"system":"slow","repo":"r","versionFrom":"v","versionMatch":"^(a+)+$"},
            {"system":"fine","repo":"r","versionFrom":"w","versionMatch":"tag: (v1)"}
        ]),
    );
    assert!(started.elapsed() < super::super::pattern::CALL_BUDGET * 3);
    assert_eq!(
        result["refused"],
        json!(["external record slow: versionMatch ran past its budget of 2 s — refused"])
    );
    assert_eq!(
        result["candidates"][0]["system"], "fine",
        "the engine still serves the next record"
    );
}
