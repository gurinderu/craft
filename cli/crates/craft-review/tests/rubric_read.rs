//! A lens's `rubricRead`: every lens answer schema offers it, and a run whose skills no path was
//! found for says so once, not again as lenses that read no rubric.

mod common;

use common::{answers, fixture, ids, lens, opts, scout, submit};
use craft_review::step;
use serde_json::{Value, json};

#[test]
fn the_unit_findings_schema_offers_rubric_read_as_the_findings_schema_does() {
    for name in ["findings", "unit-findings"] {
        let schema = craft_review::content::schema(name).unwrap();
        let field = &schema["properties"]["rubricRead"];
        assert_eq!(
            (field["type"].clone(), field["items"]["type"].clone()),
            (json!("array"), json!("string")),
            "{name}: {schema}"
        );
    }
}

#[test]
fn a_run_with_no_plugin_root_names_its_unread_rubrics_once() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    let mut o = opts(repo.path(), out.path());
    o.craft_root = None;
    step::start(&o).unwrap();
    let s = submit(&run, json!({"scout-rust": scout("small", &["errors"])}));
    // No lens could read a file it was never shown: none names one.
    let round: serde_json::Map<String, Value> = ids(&s)
        .into_iter()
        .map(|id| {
            let mut a = lens("x", &[]);
            a.as_object_mut().unwrap().remove("rubricRead");
            (id, a)
        })
        .collect();
    let s = step::submit(&run, Some(&answers(Value::Object(round)))).unwrap();
    let degraded = s["degraded"].to_string();
    assert!(
        degraded.contains("could not be named by an absolute path"),
        "{degraded}"
    );
    assert!(
        !degraded.contains("named no rubric file they read whole"),
        "the same cause named twice: {degraded}"
    );
}
