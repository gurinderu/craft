use serde_json::{Value, json};

use super::*;

fn f(sev: &str, source: &str, title: &str, line: u32) -> Value {
    json!({"severity": sev, "title": title, "file": "src/a.rs", "line": line, "why": "w", "source": source,
           "ruleId": "", "whereChecked": "", "foundInRound": line % 2 + 1})
}

#[test]
fn a_rule_flood_is_rolled_up_past_three_worst_first() {
    let p = Profile::rust().unwrap();
    let mut pool: Vec<Value> = (1..=5)
        .map(|i| {
            let mut x = f(
                if i == 5 { "Medium" } else { "Low" },
                "api-idioms",
                &format!("t{i}"),
                i,
            );
            x["ruleId"] = json!("API-001");
            x
        })
        .collect();
    pool.push(f("High", "errors", "keep", 9));
    let out = prepare(&pool, &p);
    assert_eq!(out.len(), 5);
    assert_eq!(out[0]["title"], "keep", "the rest first, in order");
    assert_eq!(out[1]["title"], "t5", "the worst instance leads its group");
    assert_eq!(out[4]["title"], "t3 — and 1 more of the same (API-001)");
    assert!(
        out[4]["why"]
            .as_str()
            .unwrap()
            .contains("Repeated 2 more times across the diff (src/a.rs:3, src/a.rs:4)")
    );
    assert_eq!(
        out[4]["foundInRound"], 1,
        "the earliest round of what it folds"
    );
}

#[test]
fn same_spot_and_model_groups_merge_as_one_component() {
    let pool = vec![
        f("Medium", "errors", "the retry loop never stops", 3),
        f("High", "reconciler", "Retry loop never stops!", 3),
        f("Low", "tests", "no test pins the stop", 8),
        f("Low", "maintainability", "unrelated", 20),
    ];
    let (out, folded) = merge(&pool, Some(&json!({"groups": [[1, 2], [7, 1], [3]]})));
    assert_eq!(folded, 2);
    assert_eq!(out.len(), 2);
    assert_eq!(out[0]["title"], "unrelated");
    let m = &out[1];
    assert_eq!(m["severity"], "High", "merged onto the worst member");
    assert_eq!(m["sources"], json!(["errors", "reconciler", "tests"]));
    assert!(
        m["why"]
            .as_str()
            .unwrap()
            .ends_with("(same defect also reported by: errors, tests)")
    );
    assert_eq!(m["foundInRound"], 1);
    let (same, n) = merge(&pool, None);
    assert_eq!(
        (same.len(), n),
        (3, 1),
        "without the model only the same-spot pair merges"
    );
}
