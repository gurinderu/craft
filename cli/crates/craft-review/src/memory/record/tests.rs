//! A record whose scope carries a line, as earlier runs wrote it (realm @nick/craft, node #606).

use serde_json::{Value, json};

use super::super::id::memory_record_id;
use super::super::matching::{plan, resolve, tried_order};
use super::{parse, plain_label, read};

/// An old record: its id the store kept, hashed when its scope still held the range.
fn old() -> Value {
    json!({"id": "decision-0123456789", "kind": "decision",
        "title": "unchecked index", "scope": "src/api/src/users.rs:1230-1245", "body": "bounded upstream", "lens": "correctness"})
}

#[test]
fn an_old_range_scope_reads_as_its_path_and_start_line_and_matches_a_finding_there() {
    let d = read(&old(), "decision #0").unwrap();
    assert_eq!((d.scope.as_str(), d.line), ("src/api/src/users.rs", 1230));
    assert_eq!(d.id, old()["id"], "the stored id is kept");
    let f = json!({"file": "src/api/src/users.rs", "line": 1231, "title": "index may panic", "lens": "correctness"});
    let ds = [d];
    let m = resolve(&f, &ds, &plan(&f, &ds, &tried_order(&ds)), None).unwrap();
    assert_eq!(m.how, "matched by file:line+lens");
}

#[test]
fn the_records_own_line_wins_over_the_one_its_scope_carries() {
    let mut o = old();
    o["line"] = json!(1240);
    assert_eq!(read(&o, "d").unwrap().line, 1240);
}

#[test]
fn two_legacy_records_of_one_title_at_two_ranges_both_apply_each_at_its_own_line() {
    let at = |scope: &str| {
        json!({"kind": "decision", "title": "unwrap may panic", "scope": scope,
        "body": "ok here", "date": "2026-01-01", "author": "a", "status": "active", "lens": "correctness"})
    };
    let p = parse(
        Some(&json!([at("src/a.rs:10-12"), at("src/a.rs:500-505")])),
        &[],
        &plain_label,
    );
    assert!(p.refused.is_empty(), "{:?}", p.refused);
    let lines: Vec<_> = p
        .decisions
        .iter()
        .map(|d| (d.scope.as_str(), d.line))
        .collect();
    assert_eq!(lines, [("src/a.rs", 10), ("src/a.rs", 500)]);
    // Each id is the hash of its scope as written, as before.
    let ids: Vec<_> = p.decisions.iter().map(|d| d.id.clone()).collect();
    let legacy = |s| memory_record_id("decision", "unwrap may panic", s);
    assert_eq!(ids, [legacy("src/a.rs:10-12"), legacy("src/a.rs:500-505")]);
    let order = tried_order(&p.decisions);
    for (line, at) in [(11, 0), (501, 1)] {
        let f = json!({"file": "src/a.rs", "line": line, "title": "unwrap may panic", "lens": "correctness"});
        // The record at the finding's own line is the sure match; the other range is at most a
        // candidate the judge is asked about, never the anchor.
        let sure = plan(&f, &p.decisions, &order).sure.unwrap();
        assert_eq!(sure.at, at, "finding at {line}");
    }
}

#[test]
fn a_scope_with_any_other_colon_is_still_refused() {
    let mut o = old();
    o["scope"] = json!("src/users.rs:12a");
    let why = read(&o, "decision #0").unwrap_err();
    assert!(why.contains("has a character outside"), "{why}");
}

#[test]
fn a_fields_ceiling_counts_utf16_units_as_javascript_does() {
    let titled = |title: String| {
        let mut o = old();
        o["title"] = json!(title);
        read(&o, "d")
    };
    // 198 letters and one emoji: 200 UTF-16 units, the ceiling (202 bytes, 199 chars).
    let at = format!("{}😀", "a".repeat(198));
    assert_eq!(titled(at).map(|d| crate::js::len(&d.title)), Ok(200));
    // One letter more: 201 units (200 chars), past it.
    let over = format!("{}😀", "a".repeat(199));
    let why = titled(over).unwrap_err();
    assert!(
        why.contains("title is 201 chars, over the 200-char ceiling"),
        "{why}"
    );
}
