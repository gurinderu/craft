use craft_store::git::GitId;
use craft_store::js::{Js, parse};
use craft_store::write::{Writing, write_record};

#[test]
fn utf16_record_write_read_and_index_keep_keys_and_values() {
    let dir = tempfile::tempdir().unwrap();
    let input = parse(r#"{"kind":"workflow","name":"review","verdict":"\ud800","\ud800":"high","\ud801":"other","�":"replacement","\\ud800":"literal","nested":{"\udc00":["\ud801",{"\ud800":"\udc01"},"😀"]}}"#).unwrap();
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
    let bytes = std::fs::read_to_string(&file).unwrap();
    assert_eq!(bytes, Js::Obj(written.clone()).pretty());
    let back =
        craft_store::read::record(dir.path(), file.file_name().unwrap().to_str().unwrap()).unwrap();
    assert_eq!(back, written);
    assert_eq!(back.get("nested"), input.as_obj().unwrap().get("nested"));
    assert!(bytes.contains(r#""\ud800": "high""#));
    assert!(bytes.contains(r#""\ud801": "other""#));
    let index = std::fs::read_to_string(dir.path().join("index.jsonl")).unwrap();
    let indexed = parse(index.trim()).unwrap();
    assert_eq!(
        indexed.as_obj().unwrap().get("verdict"),
        input.as_obj().unwrap().get("verdict")
    );
}

#[test]
fn utf16_fingerprints_match_javascript_and_distinguish_surrogate_identity() {
    for (text, want) in [
        (
            r#"{"file":"\ud800","symbol":"fn X<\ud801>","ruleId":"R"}"#,
            "4cadd6ef",
        ),
        (
            r#"{"file":"\ud801","symbol":"fn X<\ud801>","ruleId":"R"}"#,
            "4cbfef70",
        ),
        (
            r#"{"file":"\\ud800","symbol":"fn X<\ud801>","ruleId":"R"}"#,
            "7a2c53dc",
        ),
        (
            r#"{"file":"�","symbol":"fn X<\ud801>","ruleId":"R"}"#,
            "204bb56c",
        ),
        (
            r#"{"file":"a","symbol":"\ud800 fn X<Y<\udc00>>\ud801","title":"HELLO\ud800World 😀 \u212a"}"#,
            "e9054e26",
        ),
    ] {
        let value = parse(text).unwrap();
        assert_eq!(craft_store::record::fingerprint(value.as_obj()), want);
    }
}

#[test]
fn utf16_cli_filing_preserves_findings_and_nested_data() {
    let dir = tempfile::tempdir().unwrap();
    let repo = tempfile::tempdir().unwrap();
    let mut req = parse(r#"{"step":{"report":"/report.md","verdict":"Approve\ud800","findings":[{"file":"\ud800","title":"\udc00","ruleId":"\ud801"}],"uncovered":["\ud800","\\ud800"],"notRun":["\udc00"],"sorting":{"\ud800":1,"\ud801":2},"ledger":[{"file":"\ud800","symbol":"fn X<\ud801>","title":"\udc00","why":"\ud801","disposition":"\udc01","toolRule":"\ud800"}]}}"#).unwrap().as_obj().unwrap().clone();
    req.set("repo", Js::str(repo.path().display().to_string()));
    let env = craft_store::adapter::Env {
        store: dir.path().to_path_buf(),
        craft_commit: None,
        now: 0,
    };
    let response = craft_store::answer_js("finalize", &req, &env).unwrap();
    assert_eq!(response.get("ok"), Some(&Js::Bool(true)), "{response:?}");
    let text = std::fs::read_to_string(response.try_text("file").unwrap()).unwrap();
    let record = parse(&text).unwrap();
    let record = record.as_obj().unwrap();
    let step = req.get("step").unwrap().as_obj().unwrap();
    for field in ["verdict", "sorting", "notRun"] {
        assert_eq!(record.get(field), step.get(field));
    }
    assert_eq!(record.get("uncoveredFiles"), step.get("uncovered"));
    let ledger = record.get("ledger").unwrap().as_arr().unwrap()[0]
        .as_obj()
        .unwrap();
    let original = step.get("ledger").unwrap().as_arr().unwrap()[0]
        .as_obj()
        .unwrap();
    for (key, value) in original.iter() {
        assert_eq!(ledger.get(key), Some(value));
    }
}

#[test]
fn utf16_run_keys_do_not_fold_distinct_strings() {
    let base = parse(
        r#"{"head":"h","filesDigest":"d","branch":"b","findings":{"total":1},"runtime":"\ud800"}"#,
    )
    .unwrap();
    let other = parse(
        r#"{"head":"h","filesDigest":"d","branch":"b","findings":{"total":1},"runtime":"\ud801"}"#,
    )
    .unwrap();
    let a = base.as_obj().unwrap();
    let b = other.as_obj().unwrap();
    assert_ne!(
        craft_store::retro::run_key(a),
        craft_store::retro::run_key(b)
    );
    assert_eq!(
        craft_store::retro::fold_runs(vec![a.clone(), b.clone()]).len(),
        2
    );
    assert_eq!(
        craft_store::retro::engine_key(a),
        Err(craft_store::js::Utf16Error)
    );
}

#[test]
fn utf16_checkpoint_identity_never_treats_a_surrogate_as_an_absent_field() {
    use craft_store::checkpoint::{Identity, agrees, attested};
    let a = parse(r#"{"project":"p","branch":"\ud800","head":"h"}"#).unwrap();
    let b = parse(r#"{"project":"p","branch":"\ud801","head":"h"}"#).unwrap();
    let a = a.as_obj().unwrap();
    let b = b.as_obj().unwrap();
    assert_ne!(Identity::of(a), Identity::of(b));
    assert!(!agrees(
        &Identity::of(a),
        &attested(std::slice::from_ref(b))
    ));
    assert!(agrees(&Identity::of(a), &attested(std::slice::from_ref(a))));
}

#[test]
fn utf16_path_boundary_refuses_before_creating_files() {
    let store = tempfile::tempdir().unwrap();
    let env = craft_store::adapter::Env {
        store: store.path().to_path_buf(),
        craft_commit: None,
        now: 0,
    };
    let req =
        parse(r#"{"repo":"\ud800","step":{"report":"/report.md","verdict":"Approve"}}"#).unwrap();
    let result = craft_store::answer_js("finalize", req.as_obj().unwrap(), &env).unwrap();
    assert_eq!(result.get("ok"), Some(&Js::Bool(false)));
    assert!(result.text("reason").unwrap().contains("UTF-16"));
    assert_eq!(std::fs::read_dir(store.path()).unwrap().count(), 0);
}
