//! `retro()` over records in memory prices a run filed in parts once, by every part's share,
//! as `craft runs retro` does over the store (realm @nick/craft, node #658).
#![expect(
    clippy::unwrap_used,
    reason = "the fixture fails the test loudly, like the tests it serves"
)]

use craft_store::js::{Obj, parse};
use craft_store::retro::retro;

fn part(ts: &str, verdict: &str, run: &str, total: u64, source: &str) -> Obj {
    let text = format!(
        r#"{{"schemaVersion":1,"ts":"{ts}","kind":"workflow","name":"review","driver":"cli","craftVersion":"0.61.0","project":"/p","cliRun":"{run}","verdict":"{verdict}","cost":{{"output":{total},"input":0,"cacheRead":0,"cacheWrite":0,"total":{total},"agents":2,"rule":"per-message","source":"{source}"}}}}"#
    );
    parse(&text).unwrap().as_obj().unwrap().clone()
}

#[test]
fn a_resumed_run_is_priced_by_its_stopped_parts_share_and_its_own() {
    let records = [
        part("2026-11-02T10-00-00Z", "INCOMPLETE", "/r/1", 100, "wf_a"),
        part("2026-11-02T11-00-00Z", "Warning", "/r/1", 300, "wf_b"),
        part("2026-11-02T12-00-00Z", "Approve", "/r/2", 500, "wf_c"),
    ];
    let r = retro("0.61.0", records).unwrap();
    let kind = &r.kinds["review (cli)"];
    assert_eq!((kind.runs, kind.priced, kind.cost), (2, 2, 900.0));
    assert!(kind.unpriced.is_empty(), "{kind:?}");
    assert!(r.deferred.is_empty(), "every deferred run is settled");
}

#[test]
fn a_run_whose_every_part_stopped_is_priced_once_by_its_newest_part() {
    let records = [
        part("2026-11-02T10-00-00Z", "INCOMPLETE", "/r/1", 100, "wf_a"),
        part("2026-11-02T11-00-00Z", "INCOMPLETE", "/r/1", 30, "wf_b"),
    ];
    let r = retro("0.61.0", records).unwrap();
    let kind = &r.kinds["review (cli)"];
    assert_eq!(
        (kind.runs, kind.priced, kind.cost),
        (1, 1, 130.0),
        "{kind:?}"
    );
    assert_eq!(r.folded, 1);
}

#[test]
fn a_part_is_priced_by_the_id_it_was_noted_by_whatever_order_the_records_are_priced_in() {
    use craft_store::parts::Parts;
    let stopped = part("2026-11-02T10-00-00Z", "INCOMPLETE", "/r/1", 100, "wf_a");
    let first = part("2026-11-02T11-00-00Z", "Warning", "/r/1", 300, "wf_b");
    let twin = part("2026-11-02T11-00-00Z", "Warning", "/r/1", 7, "wf_c");
    let mut parts = Parts::default();
    for (id, r) in [("0", &stopped), ("1", &first), ("2", &twin)] {
        parts.note(id, r);
    }
    let total = |c: Option<craft_store::js::Js>| {
        c.and_then(|c| {
            c.as_obj()
                .and_then(|o| o.get("total"))
                .and_then(craft_store::js::Js::as_num)
        })
    };
    assert_eq!(
        total(parts.cost_of("2", &twin)),
        Some(7.0),
        "the twin priced first keeps its own"
    );
    assert_eq!(
        total(parts.cost_of("1", &first)),
        Some(400.0),
        "the first of the newest stands"
    );
}

#[test]
fn a_run_filed_twice_is_counted_once_by_its_newest_record() {
    let refiled = |ts: &str, total: u64| {
        let mut r = part(ts, "Warning", "/r/9", total, "wf_r");
        for (k, v) in [("head", "abc"), ("filesDigest", "d"), ("branch", "feat/a")] {
            r.set(k, craft_store::js::Js::str(v));
        }
        let findings = parse(r#"{"total":2,"bySeverity":{"High":2}}"#).unwrap();
        r.set("findings", findings);
        r
    };
    let records = [
        refiled("2026-11-02T10-00-00Z", 100),
        refiled("2026-11-02T12-00-00Z", 300),
        refiled("2026-11-02T11-00-00Z", 200),
    ];
    let r = retro("0.61.0", records).unwrap();
    let kind = &r.kinds["review (cli)"];
    assert_eq!((r.runs, r.folded), (1, 2));
    assert_eq!(
        (kind.priced, kind.cost),
        (1, 300.0),
        "the newest record stands: {kind:?}"
    );
}
