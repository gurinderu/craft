//! The item a changed line sits in, found past the blocks closed above it.

use crate::consumers::symbols::of_file;

/// `outer` (line 1) with a second `if`, an `else` holding a `"}"` string, and match arms; an
/// `impl` header at line 20.
const TEXT: &str = "pub fn outer(a: u8) -> u8 {\n    if a > 1 {\n        return 1;\n    }\n    if a > 2 {\n        return 2;\n    } else {\n        let s = \"}\";\n        return 3;\n    }\n    match a {\n        0 => {\n            1\n        }\n        _ => {\n            2\n        }\n    }\n}\nimpl Foo for Bar {\n}\n";

fn names(ranges: &[(u32, u32)]) -> (Vec<String>, Vec<u32>) {
    let (found, unplaced) = of_file("a.rs", TEXT, ranges);
    let names = found
        .into_iter()
        .map(|s| format!("{}:{}", s.name, s.line))
        .collect();
    (names, unplaced)
}

#[test]
fn a_line_in_a_second_block_an_else_or_a_later_arm_names_its_function() {
    for line in [6, 9, 16] {
        assert_eq!(names(&[(line, line)]).0, vec!["outer:1"], "line {line}");
    }
}

#[test]
fn a_changed_code_line_in_no_item_is_kept_as_unplaced() {
    assert_eq!(names(&[(20, 21)]), (Vec::new(), vec![20]));
}

#[test]
fn braces_in_strings_chars_and_comments_do_not_end_an_item() {
    let text = "fn f<'a>(x: &'a str) -> char {\n    let r = r#\"}\"#;\n    let c = '}';\n    /* } */ let e = '\\'';\n    // }\n    x.len();\n    c\n}\n";
    let (found, _) = of_file("a.rs", text, &[(6, 6)]);
    assert_eq!(found.first().map(|s| s.name.as_str()), Some("f"));
}

#[test]
fn the_report_names_the_changed_lines_in_no_item() {
    let c = crate::consumers::Consumers {
        sources: vec!["name search".into()],
        unplaced: vec!["src/a.rs:20".into()],
        ..Default::default()
    };
    let s = crate::consumers::section(&c);
    assert!(
        s.contains(
            "1 changed line(s) in no item the list could name, their uses not searched: src/a.rs:20"
        ),
        "{s}"
    );
    assert!(
        crate::consumers::lens_block(&crate::consumers::Consumers {
            symbols: vec![crate::consumers::Listed {
                name: "x".into(),
                file: "a.rs".into(),
                line: 1,
                sites: vec![],
            }],
            ..c
        })
        .unwrap()
        .contains("Changed lines in no item this list could name")
    );
}

#[test]
fn a_long_list_of_unplaced_lines_is_named_in_part_and_counted() {
    let many: Vec<String> = (1..=25).map(|n| format!("a.rs:{n}")).collect();
    let c = crate::consumers::Consumers {
        sources: vec!["name search".into()],
        unplaced: many,
        ..Default::default()
    };
    let s = crate::consumers::section(&c);
    assert!(s.contains("a.rs:20 and 5 more"), "{s}");
    assert!(!s.contains("a.rs:21"), "{s}");
}
