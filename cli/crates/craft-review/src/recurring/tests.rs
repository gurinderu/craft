use craft_store::js::{Js, JsString, parse};

use super::groups;
use super::read::{Row, Run};

fn run(branch: &str, file: &str, title: &str) -> Run {
    Run {
        file: format!("{branch}.json").into(),
        ts: "2026".into(),
        branch: branch.into(),
        rows: vec![Row {
            file: file.into(),
            title: title.into(),
            severity: "Low".into(),
        }],
    }
}

fn output(runs: &[Run]) -> serde_json::Value {
    let (groups, cut) = groups::recurring(runs);
    serde_json::json!({"groups": serde_json::Value::try_from(&Js::Arr(groups)).unwrap(), "cut":cut})
}

#[test]
fn title_threshold_counts_distinct_ascii_words_after_unicode_lowercase() {
    for (title, matches) in [
        ("a b c x y", true),
        ("a b x y z", false),
        ("a b c x y z", false),
        ("A A A B C D E", true),
    ] {
        let out = output(&[run("a", "f", "a b c d e"), run("b", "f", title)]);
        assert_eq!(
            out["groups"].as_array().unwrap().len(),
            usize::from(matches),
            "{title}"
        );
    }
    let out = output(&[run("a", "f", "\u{212a} İ ABC"), run("b", "f", "k i abc")]);
    assert_eq!(out["groups"].as_array().unwrap().len(), 1);
    assert_eq!(
        output(&[run("a", "f", "!!!"), run("b", "f", "!!!")])["groups"],
        serde_json::json!([])
    );
}

#[test]
fn scope_is_directional_and_the_first_matching_group_wins() {
    let broad = run("a", "./src//", "alpha beta gamma delta");
    let narrow = run("b", "src\\a.rs", "alpha beta gamma delta");
    assert_eq!(output(&[broad, narrow])["groups"][0]["file"], "./src//");
    assert_eq!(
        output(&[run("b", "src/a.rs", "same"), run("a", "src", "same")])["groups"],
        serde_json::json!([])
    );
    let out = output(&[
        run("a", "src", "a b c d e"),
        run("b", "src", "a b x y z"),
        run("c", "src/a", "a b c x y"),
        run("d", "src2/a", "a b c d e"),
    ]);
    assert_eq!(out["groups"][0]["branches"], serde_json::json!(["a", "c"]));
    assert_eq!(out["groups"].as_array().unwrap().len(), 1);
}

#[test]
fn a_later_title_can_bridge_a_match_even_beyond_the_five_displayed() {
    for n in [4, 5, 6] {
        let mut runs: Vec<_> = (0..n)
            .map(|i| run(&format!("b{i}"), "f", &format!("a b c d e v{i}")))
            .collect();
        let out = output(&runs);
        assert_eq!(
            out["groups"][0]["titles"].as_array().unwrap().len(),
            n.min(5)
        );
        assert_eq!(out["groups"][0]["titlesMore"], n.saturating_sub(5));
        runs.push(run("last", "f", "c d e v5"));
        let out = output(&runs);
        assert_eq!(
            out["groups"][0]["branches"].as_array().unwrap().len(),
            n + usize::from(n == 6)
        );
    }
}

#[test]
fn groups_are_capped_after_branch_count_and_last_seen_ranking() {
    for n in [19, 20, 21] {
        let mut runs = Vec::new();
        for i in 0..n {
            runs.push(run("a", &format!("f{i:02}"), "same"));
            runs.push(run("b", &format!("f{i:02}"), "same"));
        }
        let mut recent = run("b", "f18", "same");
        recent.ts = "2027".into();
        runs.push(recent);
        runs.push(run("c", "f17", "same"));
        let out = output(&runs);
        assert_eq!(out["groups"].as_array().unwrap().len(), n.min(20));
        assert_eq!(out["cut"], n.saturating_sub(20));
        assert_eq!(out["groups"][0]["file"], "f17");
        assert_eq!(out["groups"][1]["file"], "f18");
    }
}

#[test]
fn utf16_code_units_replace_locale_tie_breaks_and_keep_primary_ranks() {
    let mut runs = Vec::new();
    for file in ["é", "a", "Z", "😀", "\u{e000}"] {
        for branch in ["a", "Z"] {
            let mut r = run(branch, file, "same");
            r.rows = [
                "é", "a", "Z", "low", "Low", "Info", "Medium", "High", "Critical",
            ]
            .map(|s| Row {
                file: file.into(),
                title: "same".into(),
                severity: s.into(),
            })
            .into();
            runs.push(r);
        }
    }
    let out = output(&runs);
    let files: Vec<_> = out["groups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| g["file"].as_str().unwrap())
        .collect();
    assert_eq!(files, ["Z", "a", "é", "😀", "\u{e000}"]);
    assert_eq!(
        out["groups"][0]["severities"],
        serde_json::json!([
            "Critical", "High", "Medium", "Low", "Info", "Z", "a", "low", "é"
        ])
    );
    assert_eq!(out["groups"][0]["branches"], serde_json::json!(["Z", "a"]));
    assert_eq!(
        out["groups"][0]["runs"],
        serde_json::json!(["Z.json", "a.json"])
    );
}

#[test]
fn last_seen_groups_use_descending_code_units_after_branch_count() {
    let mut runs = Vec::new();
    for (file, ts) in [("x", "a"), ("y", "Z"), ("z", "é")] {
        for branch in ["a", "b"] {
            let mut r = run(branch, file, "same");
            r.ts = ts.into();
            runs.push(r);
        }
    }
    let out = output(&runs);
    let files: Vec<_> = out["groups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| g["file"].as_str().unwrap())
        .collect();
    assert_eq!(files, ["z", "x", "y"]);
}

#[test]
fn segments_and_trim_preserve_unpaired_units_without_normalizing_dot_dot() {
    let o = parse(r#"{"file":"\ufeff ./src/\ud800/../a \ufeff","title":"\u0085x\u0085"}"#).unwrap();
    let o = o.as_obj().unwrap();
    let file = super::text::text(o, "file");
    assert_eq!(Js::str(&file).compact(), r#""./src/\ud800/../a""#);
    assert_eq!(super::text::text(o, "title"), "\u{85}x\u{85}");
    let prefix = JsString::from_utf16(vec![115, 114, 99, 47, 0xd800]);
    assert!(super::text::within(&file, &prefix));
    assert!(!super::text::within(&file, &"src/a".into()));
    assert!(!super::text::within(&"./".into(), &".".into()));
    assert!(super::text::touched(&"./".into(), &[".".into()]));
}
