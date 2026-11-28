use super::super::check;
use super::{EXCLUDED, keys, required, step, steps};

#[test]
fn a_step_standing_for_a_script_spells_its_command_exactly() {
    for body in [
        "eslint . --quiet",
        "-eslint .",
        "eslint . || true",
        "time eslint .",
    ] {
        let gate = vec![
            step("lint", body),
            step("check-skills", "node integrations/shared/check-skills.mjs"),
        ];
        let report = check(&required(), EXCLUDED, &gate, &keys());
        assert_eq!(report.uncovered, ["script:lint"], "{body}");
    }
    let spaced = vec![
        step("lint", "  eslint .  "),
        step("check-skills", "node integrations/shared/check-skills.mjs"),
    ];
    assert!(check(&required(), EXCLUDED, &spaced, &keys()).is_clean());
}

#[test]
fn a_step_joined_across_lines_stands_for_its_script_only_as_just_joins_them() {
    let joined = |first: &str, second: &str| {
        let mut lint = step("lint", first);
        lint.body.push(second.to_owned());
        let gate = vec![
            lint,
            step("check-skills", "node integrations/shared/check-skills.mjs"),
        ];
        check(&required(), EXCLUDED, &gate, &keys())
    };
    // just keeps what stands before the backslash and drops the next line's indentation, adding nothing.
    assert!(joined("eslint \\", "    .").is_clean());
    assert_eq!(joined("eslint\\", "    .").uncovered, ["script:lint"]);
}

#[test]
fn a_gate_line_that_cannot_fail_its_step_is_named_with_why() {
    for (line, masked) in [
        ("-prettier --check .", true),
        ("prettier --check . || true # the formatter is flaky", true),
        ("prettier --check . | cat", true),
        ("prettier --check .", false),
        ("prettier --check . && true # fine", false),
    ] {
        let mut gate = steps();
        gate.push(step("format", line));
        let report = check(&required(), EXCLUDED, &gate, &keys());
        let named = report.masked.len() == 1
            && report
                .masked
                .iter()
                .all(|m| m.starts_with(&format!("format: {line} — ")));
        assert_eq!(named, masked, "{line}: {:?}", report.masked);
        assert_eq!(report.masked.is_empty(), !masked, "{line}");
    }
}

#[test]
fn a_script_recipe_in_the_gate_is_named() {
    let mut shebang = step("format", "#!/usr/bin/env bash");
    shebang.body.push("set -euo pipefail".to_owned());
    let mut attributed = step("other", "prettier --check .");
    attributed.script = true;
    let mut gate = steps();
    gate.extend([shebang, attributed]);
    let report = check(&required(), EXCLUDED, &gate, &keys());
    assert_eq!(
        report.masked,
        [
            "format: a script recipe (#! or [script]) runs whole, past a failed command",
            "other: a script recipe (#! or [script]) runs whole, past a failed command",
        ]
    );
}
