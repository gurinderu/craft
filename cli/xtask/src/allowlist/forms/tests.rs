use std::collections::BTreeMap;

use super::{Form, form};
use crate::justfile::recipes;
use crate::keys::Keys;

fn keys() -> Keys {
    let scripts: BTreeMap<String, String> = [
        ("lint", "eslint ."),
        (
            "check:mutation-floor",
            "node integrations/shared/check-mutation-floor.mjs",
        ),
        ("check:evals", "node integrations/shared/check-evals.mjs"),
    ]
    .into_iter()
    .map(|(n, b)| (n.to_owned(), b.to_owned()))
    .collect();
    Keys::new(&scripts).unwrap()
}

/// The form of a recipe written as `header` with the one line `line`.
fn of(header: &str, line: &str) -> Result<String, String> {
    let all = recipes(&format!("{header}\n    {line}\n"));
    let recipe = all.first().unwrap();
    form(recipe, line, &keys()).map(|f| format!("{f:?}"))
}

#[test]
fn the_two_forms_and_gate_s_own_pass() {
    assert_eq!(
        of("lint:", "npm run --silent lint"),
        Ok("Script(\"lint\")".to_owned())
    );
    assert_eq!(
        of(
            "floor base=\"\":",
            "npm run --silent check:mutation-floor -- ${1:+--base \"$1\"}"
        ),
        Ok("Script(\"check:mutation-floor\")".to_owned())
    );
    assert_eq!(
        of("steps:", "cd cli && cargo xtask gate-steps"),
        Ok("Xtask(\"gate-steps\")".to_owned())
    );
    assert_eq!(
        of("gate *args:", "cd cli && cargo xtask gate \"$@\""),
        Ok("Gate".to_owned())
    );
    assert_eq!(
        of("gate +args:", "  cd cli && cargo xtask gate \"$@\"  "),
        Ok("Gate".to_owned())
    );
    assert_eq!(
        form(&recipes("x:\n").remove(0), "npm run --silent lint", &keys()),
        Ok(Form::Script("lint"))
    );
}

#[test]
fn every_round_five_evasion_and_every_other_line_is_refused() {
    for line in [
        // quoted flags and inline code
        "node '-e' 'process.exit(0)'",
        "python3 -c'pass'",
        // cargo silencing the run, npm flag tricks
        "cd cli && cargo --config 'target.x.runner=\"true\"' xtask gate-steps",
        "cd cli && cargo xtask gate-steps --config x",
        "npm run --silent lint --cal 'true'",
        "npm run --silent --script-shell=true lint",
        "npm run --silent --node-options=--require=x lint",
        "npm run lint",
        "npm run --silent lint || true",
        "npm run --silent lint -- --fix",
        "npm  run --silent lint",
        // node's other code doors
        "node --loader ./x check.mjs",
        "node --env-file=x check.mjs",
        "node --run lint",
        "node - < x.mjs",
        // a check named in argument position
        "node check-evals.mjs node check-js-boundary.mjs",
        "npm run --silent lint check:evals",
        // unknown scripts and checks, other shapes
        "npm run --silent missing",
        "npm run --silent 'lint'",
        "cd cli && cargo xtask gate",
        "cd cli && cargo xtask other",
        "cd . && cargo xtask gate-steps",
        "eslint .",
        "",
    ] {
        let got = of("step:", line);
        assert!(
            got.as_ref()
                .is_err_and(|w| w.starts_with("not one of the two forms")),
            "{line:?}: {got:?}"
        );
    }
}

#[test]
fn the_base_form_needs_a_recipe_that_takes_base_and_gate_needs_its_own() {
    let base = "npm run --silent check:mutation-floor -- ${1:+--base \"$1\"}";
    assert_eq!(
        of("floor:", base),
        Err("the base form in a recipe that takes no `base`".to_owned())
    );
    assert_eq!(
        of("floor since=\"\":", base),
        Err("the base form in a recipe that takes no `base`".to_owned())
    );
    for (header, line) in [
        ("gate:", "cd cli && cargo xtask gate \"$@\""),
        ("gate *args:", "cd cli && cargo xtask gate"),
        ("gate *args:", "cd cli && cargo xtask gate \"$@\" || true"),
        ("gate *args:", "npm run --silent lint"),
    ] {
        assert!(
            of(header, line).is_err_and(|w| w.starts_with("`gate` is exactly")),
            "{header} {line}"
        );
    }
}
