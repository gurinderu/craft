use std::collections::HashMap;

use serde_json::json;

use super::*;

#[test]
fn a_finished_run_says_its_marked_verdict_report_and_findings() {
    let step = json!({
        "run": "/runs/a", "done": true, "report": "/runs/a/report.md", "verdict": "Block",
        "line": "Block — 1 High finding",
        "findings": [{"severity": "High", "file": "src/a.rs", "line": 3, "title": "a  bug", "tier": "confirmed"},
                     {"severity": "", "file": "b.rs", "line": 0, "title": "t", "tier": ""}],
    });
    assert_eq!(
        finished_answer(&step, "again"),
        "## Verdict\n\n⛔ Block — 1 High finding\n\nThe report is /runs/a/report.md — read that file for the findings (run /runs/a).\n\n## Findings\n\n- [High] src/a.rs:3 — a bug (confirmed)\n- [unrated] b.rs — t"
    );
}

#[test]
fn the_glyph_follows_the_verdict() {
    assert_eq!(marked("Approve"), "✅ Approve");
    assert_eq!(
        marked("Approve (PARTIAL COVERAGE)"),
        "⚠️ Approve (PARTIAL COVERAGE)"
    );
    assert_eq!(marked("Warning (INCOMPLETE)"), "⚠️ Warning (INCOMPLETE)");
    assert_eq!(marked("Blocked?"), "⚠️ Blocked?");
    assert_eq!(marked("✅ done"), "✅ done");
}

#[test]
fn a_stopped_degraded_published_run_says_each_and_how_to_resume() {
    let step = json!({
        "run": "/r/x", "report": "/r/x/report.md", "verdict": "INCOMPLETE", "line": "",
        "degraded": ["ran  without\nits agent"], "memorySections": "## Memory\n\nnone\n",
        "stopped": {"cause": "limit", "text": "You've hit your usage limit"},
        "prComments": {"posted": 1, "already": 0, "requested": 2, "reason": "one failed", "error": "422"},
        "sorting": {"doubtful": 2},
    });
    let got = finished_answer(&step, "this command again");
    assert!(got.starts_with("## Verdict\n\n⚠️ INCOMPLETE\n\n"), "{got}");
    assert!(
        got.contains(
            "⚠️ PR comments: 1 of 2 defect(s) posted, 0 already on the PR — one failed (gh: 422)."
        ),
        "{got}"
    );
    assert!(got.contains("Doubtful: 2 finding(s)"), "{got}");
    assert!(got.contains("⚠️ Degraded: part of this review ran weaker than asked — the report's Degraded section says how.\n- ran without its agent"), "{got}");
    assert!(
        got.contains("stopped: usage limit reached (You've hit your usage limit)."),
        "{got}"
    );
    assert!(got.contains("To resume it once agents can answer again: this command again, or the binary `craft review submit --run '/r/x' --resume`."), "{got}");
    assert!(
        got.contains("## Memory\n\nnone\n\n## Findings\n\nNone reported."),
        "{got}"
    );
}

#[test]
fn only_work_cut_short_counts_as_incomplete() {
    assert!(cut_short("INCOMPLETE"));
    assert!(cut_short("Warning (INCOMPLETE)"));
    assert!(!cut_short("INCOMPLETE (empty diff)"));
    assert!(!cut_short("INCOMPLETE (no language profile)"));
    assert!(!cut_short("Approve"));
}

#[test]
fn the_agents_said_section_names_the_most_frequent_three() {
    assert_eq!(said_section(&HashMap::new()), "");
    let said: HashMap<String, u64> = [("a `x`", 1), ("b", 3), ("c", 2), ("d", 1)]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v))
        .collect();
    assert_eq!(
        said_section(&said),
        "## What the agents said\n\nThe tasks that gave no answer last wrote:\n\n- 3 task(s): `b`\n- 2 task(s): `c`\n- 1 task(s): `a 'x'`"
    );
}

#[test]
fn a_stopped_answer_is_incomplete_with_why() {
    assert_eq!(
        stopped_answer("pi is not logged in"),
        "## Verdict\n\n⚠️ INCOMPLETE — pi is not logged in"
    );
}
