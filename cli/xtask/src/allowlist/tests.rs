use std::collections::BTreeMap;

use super::{directives, recipe};
use crate::justfile::recipes;
use crate::keys::Keys;

fn refused(text: &str) -> Vec<String> {
    let scripts = BTreeMap::from([("lint".to_owned(), "eslint .".to_owned())]);
    let keys = Keys::new(&scripts).unwrap();
    recipes(text)
        .iter()
        .flat_map(|r| recipe(r, &keys))
        .collect()
}

#[test]
fn a_recipe_is_one_line_with_no_dependency_and_no_attribute_but_its_group_and_doc() {
    assert!(
        refused(
            "[group('gate')]\n[doc('what it checks')]\na:\n    npm run --silent \\\n      lint\n"
        )
        .is_empty()
    );
    for (text, found) in [
        (
            "[group('gate'), script: 'sh']\na:\n    npm run --silent lint\n",
            "a: the attribute `[script:'sh']`",
        ),
        (
            "[script ( 'sh' )]\na:\n    npm run --silent lint\n",
            "a: the attribute `[script('sh')]`",
        ),
        (
            "[group('gate')]\n[private]\na:\n    npm run --silent lint\n",
            "a: the attribute `[private]`",
        ),
        (
            "[group('gate')]\n[no-exit-message]\na:\n    npm run --silent lint\n",
            "a: the attribute `[no-exit-message]`",
        ),
        ("a: b\n    npm run --silent lint\n", "a: it depends on `b`"),
        (
            "a: && b\n    npm run --silent lint\n",
            "a: it depends on `&& b`",
        ),
        (
            "a:\n    npm run --silent lint\n    vitest\n",
            "a: 2 lines, not one",
        ),
        (
            "a:\n    #!/bin/sh\n    npm run --silent lint\n",
            "a: 2 lines, not one",
        ),
        ("a:\n", "a: 0 lines, not one"),
        (
            "a:\n    npm run --silent lint | cat\n",
            "a: npm run --silent lint | cat — not one of the two forms",
        ),
    ] {
        let got = refused(text);
        assert!(
            got.iter().any(|r| r == found || r.starts_with(found)),
            "{text:?}: {got:?}"
        );
    }
}

#[test]
fn the_justfile_holds_only_its_one_setting_besides_recipes() {
    let text = format!(
        "set positional-arguments\nset guards\nset ignore-errors := false\nset unstable\nmod other\nimport 'x.just'\nexport NODE_OPTIONS := '--require x'\nexport PATH := 'fake:' + env_var('PATH')\nX := `true`\nalias g := gate\n{}\n\n# a comment\n[group('gate')]\ngate:\n    npm run --silent lint\n",
        "export PATH := justfile_directory() + \"/node_modules/.bin:\" + env_var('PATH')"
    );
    let got = directives(&crate::justfile::directives(&text));
    let expected = [
        "set guards",
        "set ignore-errors := false",
        "set unstable",
        "mod other",
        "import 'x.just'",
        "export NODE_OPTIONS := '--require x'",
        "export PATH := 'fake:' + env_var('PATH')",
        "X := `true`",
        "alias g := gate",
        "export PATH := justfile_directory() + \"/node_modules/.bin:\" + env_var('PATH')",
    ];
    assert_eq!(got.len(), expected.len(), "{got:?}");
    for (g, e) in got.iter().zip(expected) {
        assert!(g.starts_with(&format!("justfile: `{e}` — ")), "{g}");
    }
    assert!(
        got.iter()
            .all(|g| g.contains("besides its recipes the justfile holds only"))
    );
}

#[test]
fn a_parameter_is_a_name_or_a_literal_default() {
    for header in [
        "a base=\"\":",
        "a *args:",
        "a +args:",
        "a x='lit':",
        "a x y:",
        "a _x:",
        "a x-y_z9:",
    ] {
        assert!(
            refused(&format!("{header}\n    npm run --silent lint\n")).is_empty(),
            "{header}"
        );
    }
    for (header, word) in [
        ("a $PATH=\"x\":", "$PATH=\"x\""),
        ("a base=`cmd`:", "base=`cmd`"),
        ("a base=env_var('X'):", "base=env_var('X')"),
        ("a base=\"$X\":", "base=\"$X\""),
        ("a base=\"{x}\":", "base=\"{x}\""),
        ("a *$args:", "*$args"),
        ("a 9x:", "9x"),
        ("a -x:", "-x"),
        ("a x.y:", "x.y"),
        ("a x!:", "x!"),
    ] {
        let got = refused(&format!("{header}\n    npm run --silent lint\n"));
        assert!(
            got.iter()
                .any(|g| g.starts_with(&format!("a: the parameter `{word}`"))),
            "{header}: {got:?}"
        );
    }
}
