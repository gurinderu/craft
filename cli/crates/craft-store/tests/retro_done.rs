//! A retro's mark (`craft runs retro-done`) is no run: the retro of the records counts none of it,
//! as of a develop cycle (realm @nick/craft, node #658).
#![expect(
    clippy::unwrap_used,
    reason = "the fixture fails the test loudly, like the tests it serves"
)]

use craft_store::js::{Js, Obj, parse};
use craft_store::retro::{DONE_KIND, done_record, is_run, retro};

fn rec(text: &str) -> Obj {
    parse(text).unwrap().as_obj().unwrap().clone()
}

#[test]
fn the_mark_is_a_versioned_retro_record_and_neither_it_nor_a_develop_cycle_is_a_run() {
    let mark = done_record();
    assert_eq!(mark.get("kind"), Some(&Js::str(DONE_KIND)));
    assert_eq!(mark.get("name"), Some(&Js::str("retro")));
    assert_eq!(mark.get("schemaVersion"), Some(&Js::Num(1.0)));
    assert!(!is_run(&mark));
    assert!(!is_run(&rec(r#"{"kind":"develop"}"#)));
    assert!(is_run(&rec(r#"{"kind":"workflow","name":"review"}"#)));
    let review = r#"{"schemaVersion":1,"ts":"2026-11-02T10-00-00Z","kind":"workflow","name":"review","craftVersion":"0.9.0","verdict":"Warning"}"#;
    let mut marked = done_record();
    marked.set("craftVersion", Js::str("0.9.0"));
    marked.set("ts", Js::str("2026-11-02T11-00-00Z"));
    let r = retro("0.9.0", [rec(review), marked]).unwrap();
    assert_eq!(r.runs, 1, "{r:?}");
}
