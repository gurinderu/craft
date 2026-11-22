//! A record whose scope carries a line, as earlier runs wrote it (realm @nick/craft, node #598).

use serde_json::{Value, json};

use super::super::id::memory_record_id;
use super::super::matching::{plan, resolve, tried_order};
use super::{read, skill_record_id};

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
fn the_same_fact_written_with_and_without_a_range_has_one_skill_id() {
    let mut new = old();
    new["scope"] = json!("src/api/src/users.rs");
    let ids = |v: &Value| skill_record_id(v.as_object().unwrap());
    assert_eq!(ids(&old()), ids(&new));
    new.as_object_mut().unwrap().remove("id");
    assert_eq!(
        read(&new, "d").unwrap().id,
        ids(&old()),
        "derived from the path"
    );
}

#[test]
fn a_scope_with_any_other_colon_is_still_refused() {
    let mut o = old();
    o["scope"] = json!("src/users.rs:12a");
    let why = read(&o, "decision #0").unwrap_err();
    assert!(why.contains("has a character outside"), "{why}");
}
