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
