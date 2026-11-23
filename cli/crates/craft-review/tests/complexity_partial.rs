//! A complexity lens that runs over part of the change without its numbers — a file the graph's
//! answer did not wholly give, functions past what its table shows — is named in the run's
//! degraded notes: not a coverage gap, since what was measured is judged and the verdict stands.

mod common;

use serde_json::json;

/// The numbers of 201 one-line functions `f1`..`f201` of `web/app.ts`, column by column as the
/// metrics question names them.
const MANY: &str = r#"printf '{"columns":["f.name","f.start_line","f.end_line","f.cognitive","f.complexity","f.loop_depth","f.transitive_loop_depth","f.param_count","f.linear_scan_in_loop","f.alloc_in_loop","f.recursion_in_loop","f.unguarded_recursion"],"rows":['; i=1; while [ $i -le 201 ]; do [ $i -gt 1 ] && printf ','; printf '["f%s","%s","%s","3","2","1","1","0","0","false","false","false"]' $i $i $i; i=$((i+1)); done; printf ']}\n'"#;

#[test]
fn a_measured_lens_over_files_not_wholly_read_and_functions_past_its_table_is_degraded() {
    let app: String = (1..=201)
        .map(|i| format!("export const f{i} = () => {i}\n"))
        .collect();
    // The stand-in answers `web/b.ts` with no column, so its functions go unread.
    let files = [
        ("web/app.ts", app.as_str()),
        ("web/b.ts", "export const g = () => 2\n"),
    ];
    let s = common::cbm::finished_over(&files, (Some(MANY), None), &["complexity"]);
    assert!(
        s["dimensions"].to_string().contains("general:complexity"),
        "the lens ran: {s}"
    );
    assert_eq!(s["verdict"], json!("Approve"), "the verdict stands: {s}");
    assert_eq!(s["capped"], json!([]), "no coverage gap: {s}");
    let degraded = s["degraded"].as_array().unwrap();
    let note = degraded
        .iter()
        .filter_map(|d| d.as_str())
        .find(|d| d.contains("judged part of the change without the code graph's numbers"))
        .unwrap_or_else(|| panic!("{s}"));
    assert!(
        note.contains("files not wholly read, their functions unmeasured: web/b.ts (")
            && note.contains("1 function(s) past the 200 its table shows, unjudged"),
        "{note}"
    );
}
