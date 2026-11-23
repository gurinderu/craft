//! A lens's `rubricRead`: every lens answer schema offers it, and a run whose skills no path was
//! found for says so once, not again as lenses that read no rubric.

mod common;

use common::{answers, finding, fixture, git, ids, lens, opts, scout, submit, verdict};
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

/// Every pending task of `s` answered: each lens with `found` and no `rubricRead` (no lens could
/// read a file it was never shown), the dedup with no group, each verifier upholding.
fn answered(s: &Value, found: &[Value]) -> Value {
    let all: serde_json::Map<String, Value> = ids(s)
        .into_iter()
        .map(|id| {
            let a = if id.starts_with("dedup") {
                json!({"groups": []})
            } else if id.starts_with("verify") {
                verdict(false)
            } else {
                let mut a = lens("x", if id.contains("errors") { found } else { &[] });
                a.as_object_mut().unwrap().remove("rubricRead");
                a
            };
            (id, a)
        })
        .collect();
    Value::Object(all)
}

#[test]
fn a_run_with_no_plugin_root_names_its_unread_rubrics_once_whatever_phase_it_ends_in() {
    // A general-profile change: its verifiers name no skill, so the run ends past every task
    // that named one.
    let repo = fixture(false);
    let d = repo.path();
    std::fs::create_dir_all(d.join("web")).unwrap();
    std::fs::write(d.join("web/app.ts"), "export const f = () => 1\n").unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-qm", "feat: f"]);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    let mut o = opts(d, out.path());
    o.craft_root = None;
    step::start(&o).unwrap();
    let mut s = submit(&run, json!({"scout-general": scout("small", &["errors"])}));
    let mut f = finding("High", 1);
    f["file"] = json!("web/app.ts");
    let found = [f];
    let mut phases = Vec::new();
    for _ in 0..8 {
        if s["done"] == json!(true) {
            break;
        }
        s = step::submit(&run, Some(&answers(answered(&s, &found)))).unwrap();
        phases.push(s["phase"].clone());
    }
    assert!(
        phases.contains(&json!("verify")),
        "the run went past its lenses: {phases:?}"
    );
    assert_eq!(s["done"], json!(true), "{s}");
    let degraded: Vec<&str> = s["degraded"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let named = |what: &str| degraded.iter().filter(|d| d.contains(what)).count();
    assert_eq!(
        (
            named("could not be named by an absolute path"),
            named("named no rubric file they read whole")
        ),
        (1, 0),
        "one cause, named once though the lenses are long gone: {degraded:?}"
    );
}
