use super::*;

fn row(id: &str, verdict: &str, reason: &str) -> LedgerEntry {
    LedgerEntry {
        stable_id: id.into(),
        verdict: verdict.into(),
        reason: reason.into(),
        ..LedgerEntry::default()
    }
}

fn judged(id: &str, verdict: &str, reason: &str) -> Validation {
    Validation {
        stable_id: id.into(),
        verdict: verdict.into(),
        reason: reason.into(),
        ..Validation::default()
    }
}

fn repeat(id: &str, of: &str) -> LedgerEntry {
    LedgerEntry {
        sifted: Some(true),
        repeat_of: Some(of.into()),
        ..row(id, "reject", "SIFTED BEFORE VALIDATION — repeats")
    }
}

#[test]
fn with_nothing_pinned_the_plan_ledger_stands() {
    let planned = [row("a", "accept", "ok")];
    assert_eq!(
        pinned_ledger(&planned, &[], &[judged("a", "accept", "ok")]),
        planned
    );
}

#[test]
fn a_paraphrased_row_is_restored_a_dropped_one_appended_a_kept_one_untouched() {
    let dead = Validation::unjudged("d");
    let planned = [
        row("d", "accept", "looked fine"),
        row("k", "needs-decision", "x NOT JUDGED y"),
        row("a", "accept", "ok"),
    ];
    let validations = [
        dead.clone(),
        Validation::unjudged("k"),
        judged("a", "accept", "ok"),
    ];
    let got = pinned_ledger(&planned, &[repeat("r", "a")], &validations);
    assert_eq!(
        got,
        [
            dead.row(),
            row("k", "needs-decision", "x NOT JUDGED y"),
            row("a", "accept", "ok"),
            repeat("r", "a"),
        ]
    );
}

#[test]
fn a_sifted_row_the_agent_copied_without_its_fields_is_restored() {
    let planned = [row("r", "reject", "SIFTED BEFORE VALIDATION — repeats")];
    assert_eq!(
        pinned_ledger(&planned, &[repeat("r", "a")], &[]),
        [repeat("r", "a")]
    );
}

#[test]
fn a_class_one_row_carries_the_issue_action() {
    let issue = Validation {
        action: Some("issue".into()),
        ..judged("i", "defer", "not this PR's")
    };
    let rows = with_issue_actions(
        vec![row("i", "defer", "x"), row("o", "accept", "y")],
        std::slice::from_ref(&issue),
    );
    assert_eq!(rows[0].action.as_deref(), Some("issue"));
    assert_eq!(rows[1].action, None);
    let fallback = final_ledger(None, &[repeat("r", "i")], &[issue]);
    assert_eq!(fallback.len(), 2);
    assert_eq!(fallback[1].action.as_deref(), Some("issue"));
}
