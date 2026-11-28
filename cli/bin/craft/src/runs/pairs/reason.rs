//! Why a pair of rounds is not compared, in words.

/// Why a pair is not compared, by its status.
pub(super) fn reason(status: &str) -> &'static str {
    match status {
        "engine-unknown" => {
            "a round does not say which engine ran it — unknown is not \"the same\""
        }
        "engine-changed" => "engine changed between rounds — the rubric moves the cost by itself",
        "prior-unconfirmed" => "the later round does not say it chained from this round",
        "diff-moved" => {
            "the rounds did not review the same diff (head, base, path or changed-file set)"
        }
        "dirty-tree" => "a round ran on a dirty working tree",
        "incomplete" => {
            "a round did not run in full (gate did not pass, lenses not run, no verification, or partial coverage)"
        }
        "scope-not-full" => "a round scanned only a delta — re-run with `fullEvery=1`",
        "config-unknown" => {
            "a round does not record what it was given (no intent or description digest)"
        }
        "config-changed" => "the rounds ran with a different configuration",
        "memory-degraded" => "the later round did not have its memory in full",
        "cost-missing" => "no real cost on both rounds — run `craft runs enrich-cost` on each",
        "cost-malformed" => "a round's cost is not a cost's shape (corrupt store)",
        "cost-empty" => "a round's cost was written but measured nothing",
        "cost-overcounted" => {
            "a round's cost was summed per transcript line — re-run `craft runs enrich-cost`"
        }
        "cost-unknown-rule" => "a round's cost names a counting rule this reader does not know",
        "counts-malformed" => {
            "a round's candidate, finding or lens-dispatch count is not a count (corrupt store)"
        }
        "cost-partial" => "a round's cost is partial — a lower bound is not a cost",
        "cost-unbound" => "the two costs do not come from two distinct runs",
        _ => "",
    }
}
