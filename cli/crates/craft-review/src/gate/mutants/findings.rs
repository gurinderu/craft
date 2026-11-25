//! A surviving mutant as a finding (realm @nick/craft, node #646): a TEST finding of no lens — the
//! tool established that no test fails on it — at Low, the severity a survivor holds until a
//! reader names the defect it lets through and that defect's harm.

use serde_json::{Value, json};

use super::outcomes::Survivor;
use crate::gate::lines::Lines;

/// The source a survivor's finding carries: a gate tool's, so no lens counts it as a reading
/// (`crate::tool`).
const SOURCE: &str = "tool";
/// What its `toolRule` starts with, before the mutant's genre.
pub(crate) const RULE_PREFIX: &str = "cargo-mutants::";

/// The findings of `survivors` whose function the change touched, each at its repository path
/// (`workspace` the workspace's directory, repository-relative, '' at the top); and how many were
/// left out as neighbours the change did not touch.
pub(crate) fn of(survivors: &[Survivor], workspace: &str, lines: &Lines) -> (Vec<Value>, usize) {
    let mut found = Vec::new();
    let mut neighbours = 0;
    for s in survivors {
        let file = if workspace.is_empty() {
            s.file.clone()
        } else {
            format!("{}/{}", workspace.trim_end_matches('/'), s.file)
        };
        let (first, last) = s.function;
        if !(first..=last.max(first)).any(|l| lines.touches(&file, l)) {
            neighbours += 1;
            continue;
        }
        found.push(finding(s, &file));
    }
    (found, neighbours)
}

fn finding(s: &Survivor, file: &str) -> Value {
    let rule = format!("{RULE_PREFIX}{}", s.genre);
    json!({
        "severity": "Low",
        "title": format!("A mutant of the change survives the tests: {}", s.name),
        "file": file,
        "line": s.line,
        "why": "cargo-mutants changed this line of the change and every test still passed: no test fails on that change of behaviour. It stays Low until the defect the mutant lets through and its harm are named.",
        "fix": "Add or tighten a test that fails on this mutant, or name why the mutant is equivalent to the code.",
        "blastRadius": "",
        "source": SOURCE,
        "toolRule": rule,
        "ruleId": "",
        "whereChecked": "",
        "profile": "rust",
        "foundInRound": 0,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    fn survivor(file: &str, line: u32, function: (u32, u32)) -> Survivor {
        Survivor {
            file: file.into(),
            line,
            function,
            name: format!("{file}:{line}:1: replace + with *"),
            genre: "BinaryOperator".into(),
        }
    }

    fn changed(file: &str, lines: (u32, u32)) -> Lines {
        Lines::of(BTreeMap::from([(file.to_owned(), vec![lines])]))
    }

    #[test]
    fn a_survivor_in_a_touched_function_is_a_low_tool_finding_at_its_repository_path() {
        let lines = changed("cli/src/a.rs", (10, 10));
        let (found, left) = of(&[survivor("src/a.rs", 12, (9, 14))], "cli", &lines);
        assert_eq!(left, 0);
        let f = &found[0];
        assert_eq!(f["file"], "cli/src/a.rs");
        assert_eq!(f["line"], 12);
        assert_eq!(f["severity"], "Low");
        assert_eq!(f["toolRule"], "cargo-mutants::BinaryOperator");
        assert!(
            crate::tool::is_tool_finding(f),
            "no lens may count it as a reading"
        );
    }

    #[test]
    fn a_survivor_in_a_neighbour_the_change_did_not_touch_is_left_out_and_counted() {
        let lines = changed("src/a.rs", (1, 1));
        let (found, left) = of(&[survivor("src/a.rs", 2, (2, 2))], "", &lines);
        assert!(found.is_empty());
        assert_eq!(left, 1);
    }
}
