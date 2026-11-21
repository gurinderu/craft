use super::work_sign;

#[test]
fn a_work_sign_is_latin_pr_mr_or_review_a_number_or_a_pr_link() {
    for signed in [
        "глянь PR #12",
        "что с #437",
        "MR готов?",
        "сделай review",
        "посмотри PRs",
        "#5",
        "посмотри https://github.com/o/r/pull/3",
        "посмотри https://gitlab.com/o/r/-/merge_requests/7",
    ] {
        assert!(work_sign(signed), "{signed}");
    }
    for unsigned in [
        "ок",
        "давай дальше",
        "исправь замечания ревью",
        "смотри lib/pr/x.mjs",
        "открой preview",
        "это reviewed",
        "символ &#123;",
        "pr готов",
    ] {
        assert!(!work_sign(unsigned), "{unsigned}");
    }
}
