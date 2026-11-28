use super::super::check;
use super::{EXCLUDED, keys, required, step, steps};

#[test]
fn a_name_in_argument_position_covers_nothing() {
    for line in [
        "npm run --silent lint check:skills",
        "npm run --silent lint -- check:skills",
        "node check-lint.mjs npm run --silent check:skills",
        "cd cli && cargo xtask gate-steps npm run --silent check:skills",
    ] {
        let gate = vec![step("lint", "npm run --silent lint"), step("skills", line)];
        let mut req = required();
        req.remove("recipe:check-skills");
        req.insert("recipe:skills".to_owned());
        let report = check(&req, EXCLUDED, &gate, &keys());
        assert_eq!(
            report.uncovered,
            [
                "file:integrations/shared/check-skills.mjs",
                "script:check:skills"
            ],
            "{line}"
        );
        assert!(
            report
                .refused
                .iter()
                .any(|r| r.contains("not one of the two forms")),
            "{line}: {report:?}"
        );
    }
}

#[test]
fn a_step_joined_across_lines_takes_its_form_as_just_joins_it() {
    let joined = |first: &str, second: &str| {
        let mut lint = step("lint", first);
        lint.body.push(second.to_owned());
        let gate = vec![lint, step("check-skills", "npm run --silent check:skills")];
        check(&required(), EXCLUDED, &gate, &keys())
    };
    // just keeps what stands before the backslash and drops the next line's indentation, adding nothing.
    assert!(joined("npm run --silent \\", "    lint").is_clean());
    assert_eq!(
        joined("npm run --silent\\", "    lint").uncovered,
        ["script:lint"]
    );
}

#[test]
fn a_gate_step_outside_the_two_forms_is_named_with_why() {
    let mut gate = steps();
    gate.push(step("format", "prettier --check . || true"));
    let report = check(&required(), EXCLUDED, &gate, &keys());
    assert_eq!(report.refused.len(), 1, "{:?}", report.refused);
    assert!(report.refused.iter().all(|r| r.starts_with("format: prettier --check . || true — not one of the two forms")));
}
