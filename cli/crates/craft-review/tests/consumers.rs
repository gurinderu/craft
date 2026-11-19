//! `craft review start` builds the consumers list of a change with a caller: the whole list saved
//! in the run directory, the lenses handed their part; a lens answer leaving a line unmarked is
//! taken at once and the line reported.
#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "the helpers of these tests fail loudly, like the tests they serve"
)]

mod common;

use common::consumers::one_consumer;
use common::{ids, lens, opts, prompt_of, scout, submit, titled};
use craft_review::step;
use serde_json::{Value, json};

#[test]
fn start_saves_the_list_and_hands_the_lenses_its_lines() {
    let repo = tempfile::tempdir().unwrap();
    let d = repo.path();
    one_consumer(d);

    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    step::start(&opts(d, out.path())).unwrap();
    let saved: Value =
        serde_json::from_str(&std::fs::read_to_string(run.join("consumers.json")).unwrap())
            .unwrap();
    assert_eq!(saved["symbols"][0]["name"], json!("shared_target"));
    assert_eq!(
        saved["symbols"][0]["sites"][0]["file"],
        json!("src/user.rs")
    );

    let s = submit(&run, json!({"scout-rust": scout("small", &["errors"])}));
    let task = s["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == json!("lens-rust-errors-r1"))
        .unwrap_or_else(|| panic!("{:?}", ids(&s)));
    let prompt = prompt_of(task);
    assert!(prompt.contains("CONSUMERS: the"), "{prompt}");
    assert!(
        prompt.contains("- src/user.rs:2: crate::shared_target()"),
        "{prompt}"
    );
}

/// The one consumer line of [`one_consumer`].
const SITE: &str = "src/user.rs:2";

/// Drives a run over [`one_consumer`] to its end: the `errors` lens never marks [`SITE`] and
/// reports one finding in round 1; every other lens marks it when `others_mark`; the dedup groups
/// nothing and each verifier confirms. Returns the finished step, the `errors` lens's first answer
/// taken at once, never asked for again.
fn drive(others_mark: bool) -> (Value, tempfile::TempDir, tempfile::TempDir) {
    let repo = tempfile::tempdir().unwrap();
    one_consumer(repo.path());
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    let mut s = step::start(&opts(repo.path(), out.path())).unwrap();
    let mut errors_r1_asked = 0;
    while s["done"] == json!(false) {
        let mut answers = serde_json::Map::new();
        for id in ids(&s) {
            let a = if id.starts_with("scout-") {
                scout("small", &["errors"])
            } else if let Some(rest) = id.strip_prefix("lens-rust-") {
                let name = rest.split('-').next().unwrap();
                let mut a = if name == "errors" {
                    let first = rest.ends_with("-r1");
                    errors_r1_asked += usize::from(first);
                    lens(
                        name,
                        &if first {
                            vec![titled("High", 1, "f returns 2")]
                        } else {
                            vec![]
                        },
                    )
                } else {
                    lens(name, &[])
                };
                if name != "errors" && others_mark {
                    a["consumers"] = json!([{"site": SITE, "status": "checked"}]);
                }
                a
            } else if id.starts_with("dedup-") {
                json!({"groups": []})
            } else {
                common::verdict(false)
            };
            answers.insert(id, a);
        }
        s = submit(&run, Value::Object(answers));
    }
    assert_eq!(
        errors_r1_asked, 1,
        "the errors lens's unmarked answer was asked for again"
    );
    (s, repo, out)
}

#[test]
fn a_lens_answer_leaving_a_consumer_line_unmarked_is_taken_at_once_and_the_line_reported() {
    let (s, _repo, _out) = drive(false);
    let titles: Vec<&str> = s["findings"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|f| f["title"].as_str())
        .collect();
    assert!(titles.contains(&"f returns 2"), "{s}");
    let report = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    assert!(
        report.contains(&format!("- 1 line(s) no lens marked: {SITE}")),
        "{report}"
    );
    let degraded = s["degraded"].to_string();
    assert!(degraded.contains(SITE), "{s}");
}

#[test]
fn a_line_another_lens_shown_it_marked_is_not_reported() {
    let (s, _repo, _out) = drive(true);
    let titles = s["findings"].to_string();
    assert!(titles.contains("f returns 2"), "{s}");
    let report = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    assert!(!report.contains("no lens marked"), "{report}");
    assert!(s.get("degraded").is_none(), "{s}");
}
