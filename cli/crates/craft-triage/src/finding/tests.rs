use craft_store::js::parse;

use super::*;

fn at(source: &str, location: &str, title: &str) -> Finding {
    let o = Obj::new()
        .with("title", Js::str(title))
        .with("location", Js::str(location))
        .with("source", Js::str(source));
    Finding(o)
}

/// The `required` list of `path` in the schema file `name`.
fn required(name: &str, path: &[&str]) -> Vec<String> {
    let file = format!(
        "{}/../../../content/schemas/{name}.schema.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let schema = parse(&std::fs::read_to_string(file).unwrap()).unwrap();
    let node = path.iter().fold(&schema, |v, k| field::at(v, k));
    let list = field::at(node, "required").as_arr().unwrap();
    list.iter()
        .map(|k| k.as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn the_fields_read_are_the_ones_the_raw_schema_requires() {
    assert_eq!(required("triage-raw", &[]), ANSWER_FIELDS);
    assert_eq!(
        required("triage-raw", &["properties", "findings", "items"]),
        FIELDS
    );
}

#[test]
fn a_report_source_is_a_known_engine_trimmed_else_report() {
    assert_eq!(report_source(Some(" rust-audit ")), "rust-audit");
    assert_eq!(report_source(Some("\u{feff}review")), "review");
    assert_eq!(report_source(Some("weird")), "report");
    assert_eq!(report_source(Some("")), "report");
    assert_eq!(report_source(None), "report");
}

#[test]
fn the_id_is_source_location_title_with_no_loc_for_none() {
    assert_eq!(
        id_of(&at("review", "src/a.rs:1", "t")),
        "review::src/a.rs:1::t"
    );
    assert_eq!(id_of(&at("review", "", "t")), "review::no-loc::t");
    assert_eq!(id_of(&Finding(Obj::new())), "undefined::no-loc::undefined");
}

#[test]
fn a_location_names_its_file_and_line() {
    let parts = |s: &str| location_parts(s);
    assert_eq!(parts("src/a.rs:10"), ("src/a.rs".into(), 10));
    assert_eq!(parts(" src/a.rs:10:4 "), ("src/a.rs".into(), 10));
    assert_eq!(parts("src/a.rs:10-12"), ("src/a.rs".into(), 10));
    assert_eq!(parts("a:1:2:3"), ("a:1".into(), 2));
    assert_eq!(parts("a:b:3"), ("a:b".into(), 3));
    assert_eq!(parts("src/a.rs"), ("src/a.rs".into(), 0));
    assert_eq!(parts("PR-level"), (String::new(), 0));
    assert_eq!(parts("crate/module"), ("crate/module".into(), 0));
    assert_eq!(parts(""), (String::new(), 0));
    assert_eq!(parts(":3"), (String::new(), 0));
    assert_eq!(parts("two words.rs:3"), (String::new(), 0));
    // U+0085 is no whitespace to JavaScript: the location keeps it.
    assert_eq!(parts("a.rs\u{85}"), ("a.rs\u{85}".into(), 0));
    // JavaScript's `\d` is ASCII: other digits leave the whole location a path.
    assert_eq!(parts("src/a.rs:١٢"), ("src/a.rs:١٢".into(), 0));
    assert_eq!(parts("a.rs:12:٣"), ("a.rs:12:٣".into(), 0));
}

#[test]
fn severities_rank_critical_first_and_unknown_last() {
    assert_eq!(severity_rank("Critical"), 0);
    assert_eq!(severity_rank(" low "), 3);
    assert_eq!(severity_rank("INFO"), 4);
    assert_eq!(severity_rank("bad"), 5);
}

#[test]
fn a_gathered_answer_is_read_with_its_source_on_each_finding() {
    let f = r#"{"title":"t","severity":"Low","location":"","detail":"d","proposed_fix":"","thread_id":""}"#;
    let answer = parse(&format!(r#"{{"source":" review ","findings":[{f}]}}"#)).unwrap();
    let g = Gathered::read(&answer, true).unwrap();
    assert_eq!(g.source, "review");
    let sourced: Vec<Finding> = g.sourced().collect();
    assert_eq!(
        Js::Obj(sourced[0].0.clone()).compact(),
        format!("{},\"source\":\"review\"}}", f.trim_end_matches('}'))
    );
    assert_eq!(Gathered::read(&answer, false).unwrap().source, " review ");
}

#[test]
fn a_gathered_answer_missing_what_the_schema_requires_is_refused() {
    for bad in [
        r#"{"findings":[]}"#,
        r#"{"source":"r","findings":"x"}"#,
        r#"{"source":"r","findings":[1]}"#,
        r#"{"source":"r","findings":[{"title":"t"}]}"#,
    ] {
        let read = Gathered::read(&parse(bad).unwrap(), true);
        assert!(matches!(read, Err(TriageError::Answer { .. })), "{bad}");
    }
}
