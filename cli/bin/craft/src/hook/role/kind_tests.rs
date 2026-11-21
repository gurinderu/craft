use super::work_sign;

// The prompts in another script are spelled by code point: the hook's sources carry English only.

#[test]
fn a_work_sign_is_latin_pr_mr_or_review_a_number_or_a_pr_link_outside_paths() {
    for signed in [
        "\u{433}\u{43B}\u{44F}\u{43D}\u{44C} PR #12",
        "\u{447}\u{442}\u{43E} \u{441} #437",
        "MR \u{433}\u{43E}\u{442}\u{43E}\u{432}?",
        "\u{441}\u{434}\u{435}\u{43B}\u{430}\u{439} review",
        "\u{43F}\u{43E}\u{441}\u{43C}\u{43E}\u{442}\u{440}\u{438} PRs",
        "#5",
        "\u{43F}\u{43E}\u{441}\u{43C}\u{43E}\u{442}\u{440}\u{438} https://github.com/o/r/pull/3",
        "\u{43F}\u{43E}\u{441}\u{43C}\u{43E}\u{442}\u{440}\u{438} https://gitlab.com/o/r/-/merge_requests/7",
        "\u{433}\u{43B}\u{44F}\u{43D}\u{44C} pr 437",
        "pr \u{433}\u{43E}\u{442}\u{43E}\u{432}",
        "\u{447}\u{442}\u{43E} \u{441} \u{2116}437",
    ] {
        assert!(work_sign(signed), "{signed}");
    }
    for unsigned in [
        "\u{43E}\u{43A}",
        "\u{434}\u{430}\u{432}\u{430}\u{439} \u{434}\u{430}\u{43B}\u{44C}\u{448}\u{435}",
        "\u{438}\u{441}\u{43F}\u{440}\u{430}\u{432}\u{44C} \u{437}\u{430}\u{43C}\u{435}\u{447}\u{430}\u{43D}\u{438}\u{44F} \u{440}\u{435}\u{432}\u{44C}\u{44E}",
        "\u{441}\u{43C}\u{43E}\u{442}\u{440}\u{438} integrations/shared/pr/x.mjs",
        "\u{43E}\u{442}\u{43A}\u{440}\u{43E}\u{439} preview",
        "\u{44D}\u{442}\u{43E} reviewed",
        "\u{441}\u{438}\u{43C}\u{432}\u{43E}\u{43B} &#123;",
        "\u{2116}",
        "\u{441}\u{43C}\u{43E}\u{442}\u{440}\u{438} ~/pr",
    ] {
        assert!(!work_sign(unsigned), "{unsigned}");
    }
}
