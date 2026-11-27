//! A complexity lens the completeness critic admits, through the critic's phases: its findings are
//! sifted as a round's metrics lens's are, and what it judges without the graph's numbers is named
//! in the degraded notes, as the plan's own lens's is.

mod common;

use common::cbm::{drive, quiet, scouted_over};
use common::verdict;
use serde_json::{Value, json};

#[test]
fn a_complexity_lens_the_critic_admits_is_sifted_and_names_what_it_left_unmeasured() {
    // The stand-in answers `web/b.ts` with no column, so its functions go unread.
    // Padded past the lines that make a change large, which is what asks the critic.
    let b = format!("export const g = () => 2\n{}", "// note\n".repeat(450));
    let files = [
        ("web/app.ts", "export const f = () => 1\n"),
        ("web/b.ts", b.as_str()),
    ];
    let (run, s, _dirs) = scouted_over(&files, (None, None), ("large", &["correctness"]));
    assert!(
        !s.to_string().contains("lens-general-complexity"),
        "the plan runs no complexity lens: {s}"
    );
    let finding = |title: &str, metrics: Value| {
        json!({"severity": "Medium", "title": title, "file": "web/app.ts", "line": 1, "why": "w",
               "fix": "x", "blastRadius": "", "source": "complexity", "ruleId": "", "whereChecked": "",
               "metrics": metrics})
    };
    let s = drive(&run, s, |id| match id {
        "critic-general" => json!({"missingLenses": ["complexity"], "notes": "coverage complete"}),
        "critic-lens-general-complexity" => json!({"lens": "complexity", "findings": [
            finding("bare", json!({"function": "f"})),
            finding("measured", json!({"function": "f", "cognitive": 3})),
        ]}),
        id if id.starts_with("dedup") => json!({"groups": []}),
        id if id.contains("verify") => verdict(false),
        id => quiet(id),
    });
    let report = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    assert!(
        report.contains("complexity: 1 finding(s) dropped") && report.contains("— measured"),
        "{report}"
    );
    let degraded = s["degraded"].to_string();
    assert!(
        degraded.contains("judged part of the change without the code graph's numbers")
            && degraded.contains("web/b.ts ("),
        "{s}"
    );
}
