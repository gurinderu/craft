use serde_json::{Value, json};

use super::super::record::{parse, plain_label};
use super::super::{Memory, PriorDecision, RecordKind};
use super::{kept_records, path_entries, spread};
use crate::rereview::Chain;

fn strings(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| (*s).to_owned()).collect()
}

#[test]
fn changed_paths_past_the_bound_are_listed_by_directory_not_cut() {
    let few = strings(&["src/a.rs", "src/b.rs"]);
    assert_eq!(path_entries(&few, 60), (few.clone(), 0, 0));
    // 70 files under three crates: as deep as fits, every path covered by an entry.
    let mut many: Vec<String> = (0..40).map(|i| format!("crates/x/src/f{i}.rs")).collect();
    many.extend((0..25).map(|i| format!("crates/y/src/g{i}.rs")));
    many.extend((0..4).map(|i| format!("crates/z/h{i}.rs")));
    many.push("README.md".into());
    let (entries, grouped, cut) = path_entries(&many, 60);
    assert_eq!(cut, 0);
    assert_eq!(
        grouped, 65,
        "the files two directories deep go by their directory"
    );
    assert_eq!(
        entries,
        strings(&[
            "README.md",
            "crates/x/src/",
            "crates/y/src/",
            "crates/z/h0.rs",
            "crates/z/h1.rs",
            "crates/z/h2.rs",
            "crates/z/h3.rs"
        ]),
        "as deep as still fits: the shallower files keep their own entry"
    );
}

#[test]
fn more_top_level_entries_than_the_bound_are_cut_and_counted() {
    let paths: Vec<String> = (0..65).map(|i| format!("f{i:02}.rs")).collect();
    let (entries, grouped, cut) = path_entries(&paths, 60);
    assert_eq!((entries.len(), grouped, cut), (60, 0, 5));
}

fn record(i: usize, scope: &str, line: u64) -> Value {
    json!({"id": format!("decision-{i}"), "title": format!("t{i}"), "reason": "r", "scope": scope, "line": line})
}

#[test]
fn past_the_cap_the_records_closest_to_the_reviewed_paths_are_kept() {
    let paths = strings(&["src/a.rs"]);
    let list = vec![
        record(0, ".", 0),
        record(1, "other/x.rs", 0),
        record(2, "src", 0),
        record(3, "src/a.rs", 0),
        json!({"id": "decision-4", "title": "t", "reason": "r", "scope": "other/y.rs", "date": "2026-11-01"}),
    ];
    assert_eq!(
        kept_records(&list, &paths, 5),
        [true; 5],
        "under the cap all stay"
    );
    assert_eq!(
        kept_records(&list, &paths, 3),
        [false, false, true, true, true],
        "the file, its directory, then the newer of two unrelated files; the whole repo last"
    );
}

fn finding(file: &str, severity: &str) -> Value {
    json!({"severity": severity, "title": format!("defect in {file}"), "file": file, "line": 25, "tier": "confirmed", "why": "w"})
}

#[test]
fn past_the_judges_bound_each_finding_gets_its_best_candidate_first() {
    let findings = [finding("a.rs", "Low"), finding("b.rs", "Medium")];
    // a.rs holds five candidates, b.rs one: an order by rank alone would spend the bound on a.rs.
    let ranked: Vec<(usize, usize)> = (0..5).map(|d| (0, d)).chain([(1, 5)]).collect();
    let group = |_: &Value| 0;
    assert_eq!(spread(ranked.clone(), 6, &findings, &[], &group), ranked);
    let out = spread(ranked, 3, &findings, &[], &group);
    assert_eq!(out.get(..3), Some([(0, 0), (0, 1), (1, 5)].as_slice()));
    assert_eq!(out.len(), 6, "the cut pairs stay, after the sent ones");
}

/// 160 decisions and 200 disputed pairs, a delta over three files: every pair of a finding on
/// those files is judged, though the findings off the delta come first in the run's order.
#[test]
fn a_delta_round_judges_every_pair_on_its_files_past_both_bounds() {
    let delta = strings(&["a.rs", "b.rs", "c.rs"]);
    let lines = [10, 20, 30, 40];
    let mut list = Vec::new();
    for (k, file) in (0..37)
        .map(|k| format!("o{k}.rs"))
        .chain(delta.clone())
        .enumerate()
    {
        for (j, line) in lines.iter().enumerate() {
            list.push(record(k * 4 + j, &file, *line));
        }
    }
    assert_eq!(list.len(), 160);
    let parsed = parse(Some(&Value::Array(list)), &delta, &plain_label);
    assert_eq!(parsed.decisions.len(), 100);
    let on_delta = |d: &PriorDecision| delta.contains(&d.scope);
    assert_eq!(parsed.decisions.iter().filter(|d| on_delta(d)).count(), 12);
    // 41 findings off the delta on files whose records were kept (164 pairs), then 9 on it (36).
    let mut settled: Vec<Value> = (0..22)
        .flat_map(|k| vec![finding(&format!("o{k}.rs"), "Medium"); if k < 19 { 2 } else { 1 }])
        .collect();
    settled.extend(delta.iter().flat_map(|f| vec![finding(f, "Medium"); 3]));
    let mut m = Memory {
        decisions: parsed.decisions,
        ..Memory::default()
    };
    let repo = std::path::Path::new("/nonexistent/craft-memory-test");
    assert!(
        m.match_task(repo, &settled, &Chain::default(), &delta)
            .unwrap()
            .is_some()
    );
    let asked = m.asked.matched.clone().unwrap().pairs;
    let on_file = |fi: usize| delta.iter().any(|d| settled[fi]["file"] == d.as_str());
    assert_eq!(asked.len(), 40);
    assert_eq!(asked.iter().filter(|(fi, _)| on_file(*fi)).count(), 36);
}

#[test]
fn past_the_rule_judges_bound_the_findings_on_the_reviewed_paths_go_first() {
    let rule = PriorDecision {
        id: "rule-a".into(),
        kind: RecordKind::Rule,
        title: "clones are fine".into(),
        scope: ".".into(),
        reason: "r".into(),
        ..PriorDecision::default()
    };
    let mut settled: Vec<Value> = (0..405)
        .map(|k| finding(&format!("o{k}.rs"), "Low"))
        .collect();
    settled.push(finding("a.rs", "Medium"));
    let mut m = Memory {
        decisions: vec![rule],
        ..Memory::default()
    };
    let focus = strings(&["a.rs"]);
    assert!(
        !m.rule_tasks(&settled, &Chain::default(), &focus)
            .unwrap()
            .is_empty()
    );
    let pairs = m.asked.ruled.clone().unwrap();
    assert_eq!(pairs.len(), 406);
    assert!(
        pairs.iter().take(400).any(|&(fi, _)| fi == 405),
        "{pairs:?}"
    );
}

#[test]
fn a_path_spelled_with_dot_or_doubled_slashes_is_covered_by_its_directory_entry() {
    let paths = strings(&["./a/x.rs", "a//y.rs", "b/z.rs"]);
    assert_eq!(path_entries(&paths, 2), (strings(&["a/", "b/"]), 3, 0));
}
