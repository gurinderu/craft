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
fn a_step_joined_across_lines_as_just_joins_them_still_stands_for_its_script() {
    let mut lint = step("lint", "eslint \\");
    lint.body.push("    .".to_owned());
    let gate = vec![
        lint,
        step("check-skills", "node integrations/shared/check-skills.mjs"),
    ];
    assert!(check(&required(), EXCLUDED, &gate, &keys()).is_clean());
}

#[test]
fn a_gate_line_that_cannot_fail_its_step_is_named() {
    for (line, masked) in [
        ("-prettier --check .", true),
        ("@-prettier --check .", true),
        ("-@prettier --check .", true),
        ("prettier --check . || true", true),
        ("prettier --check . ||true", true),
        ("prettier --check . ; true", true),
        ("prettier --check . || :", true),
        ("prettier --check .", false),
        ("@prettier --check .", false),
        ("prettier --check . && true", false),
        ("x --true", false),
    ] {
        let mut gate = steps();
        gate.push(step("format", line));
        let report = check(&required(), EXCLUDED, &gate, &keys());
        let want: Vec<String> = if masked {
            vec![format!("format: {line}")]
        } else {
            Vec::new()
        };
        assert_eq!(report.masked, want, "{line}");
    }
}
