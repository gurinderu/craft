use super::{directives, recipe};
use crate::justfile::recipes;

fn refused(text: &str) -> Vec<String> {
    recipes(text).iter().flat_map(recipe).collect()
}

#[test]
fn a_recipe_is_one_line_with_no_dependency_and_no_attribute_but_its_group_and_doc() {
    assert!(
        refused("[group('gate')]\n[doc('what it checks')]\na:\n    tool \\\n      --flag\n")
            .is_empty()
    );
    for (text, found) in [
        (
            "[group('gate'), script: 'sh']\na:\n    tool\n",
            "a: the attribute `[script:'sh']`",
        ),
        (
            "[script ( 'sh' )]\na:\n    tool\n",
            "a: the attribute `[script('sh')]`",
        ),
        (
            "[group('gate')]\n[private]\na:\n    tool\n",
            "a: the attribute `[private]`",
        ),
        (
            "[group('gate')]\n[no-exit-message]\na:\n    tool\n",
            "a: the attribute `[no-exit-message]`",
        ),
        ("a: b\n    tool\n", "a: it depends on `b`"),
        ("a: && b\n    tool\n", "a: it depends on `&& b`"),
        ("a:\n    tool\n    other\n", "a: 2 lines, not one"),
        ("a:\n    #!/bin/sh\n    tool\n", "a: 2 lines, not one"),
        ("a:\n", "a: 0 lines, not one"),
        ("a:\n    tool | cat\n", "a: tool | cat — `|`"),
    ] {
        let got = refused(text);
        assert!(
            got.iter().any(|r| r == found || r.starts_with(found)),
            "{text:?}: {got:?}"
        );
    }
}

#[test]
fn the_justfile_sets_only_what_the_gate_needs_and_imports_nothing() {
    let all = [
        "set positional-arguments",
        "set guards",
        "set ignore-errors := false",
        "set unstable",
        "mod other",
    ]
    .map(str::to_owned);
    let got = directives(&all);
    assert_eq!(got.len(), 4, "{got:?}");
    assert!(got[0].starts_with(
        "justfile: `set guards` — the gate's justfile sets only set positional-arguments"
    ));
    assert!(got[3].starts_with("justfile: `mod other` — it brings in recipes"));
}
