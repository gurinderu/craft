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
fn a_gate_step_outside_the_form_is_named_with_why() {
    for (line, refused) in [
        ("-prettier --check .", true),
        ("prettier --check . || true # the formatter is flaky", true),
        ("prettier --check . | cat", true),
        ("prettier --check .", false),
        ("prettier --check . && node x.mjs 2>&1", false),
    ] {
        let mut gate = steps();
        gate.push(step("format", line));
        let report = check(&required(), EXCLUDED, &gate, &keys());
        let named = report.refused.len() == 1
            && report
                .refused
                .iter()
                .all(|m| m.starts_with(&format!("format: {line} — ")));
        assert_eq!(named, refused, "{line}: {:?}", report.refused);
        assert_eq!(report.refused.is_empty(), !refused, "{line}");
    }
}
