use craft_review::filing::WriteError;
use serde_json::json;

use super::{Filed, answered, filed, keep};

fn base() -> Filed {
    Filed {
        pass: 2,
        ..Filed::default()
    }
}

#[test]
fn the_writers_answer_is_kept_filed_with_what_did_not_land_beside_it() {
    let ok = answered(
        &base(),
        Ok(json!({"ok": true, "reason": "", "file": "/s/r.json"})),
    );
    assert_eq!(
        (ok.pass, ok.record.as_str(), ok.file.as_str()),
        (2, "filed", "/s/r.json")
    );
    assert!(ok.lost.is_empty());
    let partly = answered(
        &base(),
        Ok(json!({"ok": true, "reason": "no index", "file": "/s/r.json"})),
    );
    assert_eq!(partly.record, "filed");
    assert_eq!(
        partly.lost,
        ["the run directory (the record itself landed) — no index"]
    );
}

#[test]
fn a_refusal_or_a_broken_writer_is_a_failed_filing_saying_why() {
    let refused = answered(
        &base(),
        Ok(json!({"ok": false, "reason": "full", "file": "/s/r.json"})),
    );
    assert_eq!(
        (refused.record.as_str(), refused.file.as_str()),
        ("failed", "/s/r.json")
    );
    assert_eq!(refused.lost, ["the run record — full"]);
    let no = answered(&base(), Ok(json!({"ok": false})));
    assert_eq!(no.record, "failed");
    assert_eq!(no.lost, ["the run record — the writer gave no reason"]);
    let broken = answered(&base(), Err(WriteError::Broken("gone".into())));
    assert_eq!(broken.record, "failed");
    assert!(broken.lost[0].contains("gone"), "{broken:?}");
}

#[test]
fn a_pass_is_filed_only_by_a_filing_of_its_own_that_landed() {
    let d = tempfile::tempdir().unwrap();
    assert!(!filed(d.path(), 2));
    keep(
        d.path(),
        &Filed {
            record: "filed".into(),
            ..base()
        },
    )
    .unwrap();
    assert!(filed(d.path(), 2) && !filed(d.path(), 3));
    keep(
        d.path(),
        &Filed {
            record: "attempted".into(),
            ..base()
        },
    )
    .unwrap();
    assert!(!filed(d.path(), 2));
}
