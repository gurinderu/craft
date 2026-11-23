use super::*;
use craft_store::js::{Obj, parse};

fn j(s: &str) -> Js {
    parse(s).unwrap()
}

fn v(verdict: &str, class: &str, premise: &str) -> Row {
    Row(Obj::new()
        .with("stable_id", Js::str("id"))
        .with("verdict", Js::str(verdict))
        .with("reason", Js::str("why"))
        .with("premise_checked", Js::str(premise))
        .with("noise_class", j(class)))
}

#[test]
fn the_noise_class_is_numbers_integer_from_one_to_six_else_zero() {
    let class = |c: &str| noise_class_of(&v("accept", c, ""));
    assert_eq!(class("1"), 1);
    assert_eq!(class(r#""6""#), 6);
    assert_eq!(class("true"), 1);
    assert_eq!(class("[5]"), 5);
    assert_eq!(class(r#""0x1""#), 1);
    assert_eq!(class("7"), 0);
    assert_eq!(class("1.5"), 0);
    assert_eq!(class("0.9999999999999999"), 0);
    assert_eq!(class("5.000000000000001"), 0);
    assert_eq!(class(r#""x""#), 0);
    assert_eq!(class("null"), 0);
    assert_eq!(noise_class_of(&Row::default()), 0);
}

#[test]
fn a_pr_base_counts_only_beside_a_different_base() {
    assert_eq!(effective_pr_base(" abc1234 ", "def5678"), "abc1234");
    assert_eq!(effective_pr_base("abc1234", ""), "");
    assert_eq!(effective_pr_base("HEAD", "v1"), "");
    assert_eq!(effective_pr_base("v1", "v1"), "");
    assert_eq!(effective_pr_base("ABC1234", "abc1234ffff"), "");
    assert!(!same_commit("abc12", "abc12ff"));
}

#[test]
fn the_class_one_line_names_the_fork_point_or_a_human() {
    assert!(class_one_base_line("b1").contains("exactly `git show b1:<path>`"));
    assert!(class_one_base_line(" ").starts_with("no prBase"));
}

#[test]
fn a_premise_opened_at_exactly_the_ref() {
    assert!(opened_at("git show b1:src/a.rs", "b1"));
    assert!(opened_at("see `git show b1:x`", "b1"));
    assert!(opened_at("(git show b1:x)", "b1"));
    assert!(!opened_at("xgit show b1:x", "b1"));
    assert!(!opened_at("git show b12:x", "b1"));
    assert!(!opened_at("git show b1: x", "b1"));
    assert!(!opened_at("git show b1:", "b1"));
    assert!(opened_at("é git show b1:x", "b1"));
    assert!(opened_at("xgit show b1:x then git show b1:y", "b1"));
}

#[test]
fn class_one_defers_with_an_issue_only_when_shown_at_the_fork_point() {
    let shown = classified_verdict(v("accept", "1", "git show b1:a.rs"), "b1");
    assert_eq!(
        (&*shown.verdict(), &*shown.text("action")),
        ("defer", "issue")
    );
    let other = classified_verdict(v("defer", "1", "git show HEAD:a.rs"), "b1");
    assert_eq!(other.verdict(), "needs-decision");
    assert!(
        other
            .text("reason")
            .ends_with("fork point b1 was opened to show it — why")
    );
    let none = classified_verdict(v("accept", "1", ""), "");
    assert!(none.text("reason").contains("no prBase"));
    assert_eq!(
        classified_verdict(v("reject", "1", ""), "b1").verdict(),
        "reject"
    );
    assert_eq!(
        classified_verdict(v("accept", "5", ""), "").verdict(),
        "needs-decision"
    );
    assert_eq!(
        classified_verdict(v("accept", "6", ""), "").verdict(),
        "accept"
    );
}
