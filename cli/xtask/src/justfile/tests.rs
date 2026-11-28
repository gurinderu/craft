use super::{gate_steps, header, recipes};

const TEXT: &str = r#"# a comment
set positional-arguments

export PATH := "x:" + env_var('PATH')
answer := "4:2"

gate *args:
    cd cli && cargo xtask gate "$@"

[group('gate')]
first:
    echo one
    echo two

[private]
[group("gate"), no-cd]
@second base="" +rest:
	echo second

[group('gate')]
alias g := gate

third: first
    echo three
"#;

#[test]
fn reads_each_recipe_in_file_order_with_its_params_groups_and_body() {
    let all = recipes(TEXT);
    let names: Vec<&str> = all.iter().map(|r| r.name.as_str()).collect();
    assert_eq!(names, ["gate", "first", "second", "third"]);
    let gate = &all[0];
    assert_eq!(gate.params, ["args"]);
    assert!(gate.groups.is_empty());
    assert_eq!(gate.body, [r#"cd cli && cargo xtask gate "$@""#]);
    assert_eq!(all[1].body_text(), "echo one\necho two");
    assert_eq!(all[2].params, ["base", "rest"]);
    assert_eq!(all[2].groups, ["gate"]);
    assert_eq!(all[2].body, ["echo second"]);
}

#[test]
fn an_attribute_belongs_to_the_next_recipe_only_and_a_non_recipe_line_drops_it() {
    let all = recipes(TEXT);
    // `[group('gate')]` above an alias does not reach `third`.
    assert!(all[3].groups.is_empty());
    assert_eq!(all[3].params, Vec::<String>::new());
    assert_eq!(all[3].body, ["echo three"]);
}

#[test]
fn the_gate_steps_are_the_gate_group_in_order() {
    let steps: Vec<String> = gate_steps(&recipes(TEXT))
        .into_iter()
        .map(|r| r.name)
        .collect();
    assert_eq!(steps, ["first", "second"]);
}

#[test]
fn indented_lines_after_a_setting_belong_to_no_recipe() {
    let all = recipes("first:\n    a\nx := '1'\n    b\n");
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].body, ["a"]);
}

#[test]
fn a_comment_between_an_attribute_and_its_recipe_keeps_the_attribute() {
    let all = recipes("[group('gate')]\n# what it checks\nfirst:\n    a\n");
    assert_eq!(all[0].groups, ["gate"]);
}

#[test]
fn a_header_names_a_recipe_only_by_just_s_name_characters() {
    for (line, name) in [
        ("_hidden:", "_hidden"),
        ("a-b_c9 x:", "a-b_c9"),
        ("@quiet:", "quiet"),
    ] {
        assert_eq!(
            header(line).map(|h| h.name).as_deref(),
            Some(name),
            "{line}"
        );
    }
    for line in [
        "9a:",
        "a.b:",
        "a/b:",
        "-a:",
        "x := 'a:b'",
        "set shell := ['sh']",
        "export X := '1'",
    ] {
        assert!(header(line).is_none(), "{line}");
    }
}

#[test]
fn continued_lines_join_as_just_joins_them() {
    let all = recipes("a:\n    echo one\\\n        two  \\\n    three\n    echo four\n");
    // `just --dry-run a` prints `echo onetwo  three`.
    assert_eq!(all[0].commands(), ["echo onetwo  three", "echo four"]);
}

#[test]
fn reads_attributes_dependencies_and_directives() {
    let text = "set positional-arguments\nset  shell := ['bash']\nimport 'x.just'\nexport A := '1'\n\n[group('gate'), script: 'sh']\n[doc('a, b'), confirm(x, y)]\na: b && c\n    x\n\n[script ( 'sh' )]\nb:\n    x\n";
    let all = recipes(text);
    assert_eq!(
        all[0].attributes,
        [
            "group('gate')",
            "script:'sh'",
            "doc('a, b')",
            "confirm(x,y)"
        ]
    );
    assert_eq!(all[0].dependencies, "b && c");
    assert_eq!(all[1].attributes, ["script('sh')"]);
    assert_eq!(all[1].dependencies, "");
    assert_eq!(
        crate::justfile::directives(text),
        [
            "set positional-arguments",
            "set shell := ['bash']",
            "import 'x.just'",
            "export A := '1'"
        ]
    );
}
