//! The sorting and the comment body held to the engine's by `content/parity/sort-cases.json`, whose
//! expected side `lib/finding-sort-parity.test.mjs` computes with `lib/finding-sort.mjs`,
//! `lib/memory-contradiction.mjs` and `lib/finding-comment.mjs`.

use std::collections::BTreeMap;

use serde_json::{Value, json};

use super::{body, sort};
use crate::gate::lines::Lines;

const CASES: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../content/parity/sort-cases.json"
));

/// The changed lines a case gives, `None` for unknown.
fn changed(c: &Value) -> Option<Lines> {
    let map = c.as_object()?;
    let ranges: BTreeMap<String, Vec<(u32, u32)>> = map
        .iter()
        .map(|(file, rs)| {
            let rs = rs
                .as_array()
                .unwrap()
                .iter()
                .map(|r| {
                    let n = |i: usize| u32::try_from(r[i].as_u64().unwrap()).unwrap();
                    (n(0), n(1))
                })
                .collect();
            (file.clone(), rs)
        })
        .collect();
    Some(Lines::of(ranges))
}

#[test]
fn the_sorting_counting_and_body_are_the_engines() {
    let file: Value = serde_json::from_str(CASES).unwrap();
    for c in file["cases"].as_array().unwrap() {
        let (name, f, want) = (&c["name"], &c["finding"], &c["expected"]);
        let lines = changed(&c["changed"]);
        let (defect, doubtful) = sort::sort(std::slice::from_ref(f), lines.as_ref());
        let (sorted, reasons) = match (defect.first(), doubtful.first()) {
            (Some(_), _) => ("defect", Vec::new()),
            (None, Some((_, r))) => ("doubtful", r.clone()),
            (None, None) => ("none", Vec::new()),
        };
        assert_eq!(json!(sorted), want["sorted"], "{name}: sorted");
        assert_eq!(json!(reasons), want["reasons"], "{name}: reasons");
        let counted =
            crate::memory::contradiction_record(std::slice::from_ref(f), lines.as_ref(), |_| {
                sorted == "defect"
            });
        let signs: Vec<&Value> = counted["findings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| &x["doubtSigns"])
            .collect();
        let got = json!({"count": counted["count"], "doubtSignsAlone": counted["doubtSignsAlone"], "inDiffJudged": counted["inDiffJudged"], "doubtSigns": signs});
        assert_eq!(got, want["contradictions"], "{name}: contradictions");
        assert_eq!(json!(body::defect(f)), want["body"], "{name}: body");
    }
}
