//! `craft review post`: a chosen doubtful finding posted, its choice recorded.

use serde_json::{Value, json};

use super::support::{Posting, craft, text};

#[test]
fn a_chosen_finding_is_posted_with_the_marker_and_its_choice_recorded() {
    let f = Posting::new();
    let (repo, bin, record, head) = (&f.repo, &f.bin, &f.record, &f.head);
    let store = &f.store;
    let s = store.path().to_str().unwrap();
    let out = craft(
        repo,
        bin,
        &[
            "review", "post", "--n", "1", "--as", "question", "--store", s,
        ],
        "",
    );
    assert!(out.status.success(), "{}", text(&out.stderr));
    let said: Value = serde_json::from_str(&text(&out.stdout)).unwrap();
    assert_eq!(
        (&said["pr"], &said["posted"], &said["commit"]),
        (&json!(5), &json!(true), &json!(head))
    );
    assert!(
        said["recorded"]
            .as_str()
            .unwrap()
            .starts_with("recorded question for doubtful finding 1 (t @ a.rs:3)"),
        "{said}"
    );
    let sent: Value =
        serde_json::from_str(&std::fs::read_to_string(bin.join("sent.json")).unwrap()).unwrap();
    assert_eq!((&sent["path"], &sent["line"]), (&json!("a.rs"), &json!(3)));
    assert!(
        sent["body"]
            .as_str()
            .unwrap()
            .ends_with("<!-- craft-kind: question -->\n<!-- craft-finding -->")
    );
    let r: Value = serde_json::from_str(&std::fs::read_to_string(record).unwrap()).unwrap();
    assert_eq!(r["sorting"]["choices"]["1"]["choice"], json!("question"));
    let none = craft(
        repo,
        bin,
        &["review", "post", "--n", "9", "--as", "defect", "--store", s],
        "",
    );
    assert_eq!(none.status.code(), Some(2));
    assert!(
        text(&none.stderr).contains("the run record lists no doubtful finding numbered 9"),
        "{}",
        text(&none.stderr)
    );
}

#[test]
fn review_post_refuses_what_it_cannot_tell_with_2_and_fails_a_post_with_1() {
    let f = Posting::new();
    let refused = f.post(&["--n", "9", "--as", "defect"]);
    assert_eq!(refused.status.code(), Some(2), "{}", text(&refused.stderr));
    let other = format!(
        r#"{{"number":6,"url":"u","headRefOid":"{}","headRefName":"other"}}"#,
        "f".repeat(40)
    );
    std::fs::write(f.bin.join("view"), other).unwrap();
    let wrong_pr = f.post(&["--n", "1", "--as", "question", "--pr", "6"]);
    assert_eq!(
        wrong_pr.status.code(),
        Some(2),
        "{}",
        text(&wrong_pr.stderr)
    );
    assert!(
        text(&wrong_pr.stderr).contains("PR #6 has head branch other, not the record's feat/x"),
        "{}",
        text(&wrong_pr.stderr)
    );
    std::fs::remove_file(f.bin.join("view")).unwrap();
    std::fs::write(f.bin.join("fail-post"), "").unwrap();
    let failed = f.post(&["--n", "1", "--as", "question"]);
    assert_eq!(failed.status.code(), Some(1), "{}", text(&failed.stderr));
    assert!(
        text(&failed.stderr).contains("HTTP 500"),
        "{}",
        text(&failed.stderr)
    );
    assert!(
        text(&failed.stderr).contains(&format!(
            "record {}: a retry names it with --record",
            f.record.display()
        )),
        "{}",
        text(&failed.stderr)
    );
    assert!(!f.bin.join("sent.json").exists(), "nothing posted");
    let r: Value = serde_json::from_str(&std::fs::read_to_string(&f.record).unwrap()).unwrap();
    assert!(
        r["sorting"].get("choices").is_none(),
        "no choice recorded for a post that failed"
    );
}
