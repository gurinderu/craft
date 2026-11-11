//! A task's deadline by its kind, as the review engine sets an agent's by its phase
//! (lib/cli-review-deadline.mjs, lib/review-deadlines.mjs): the scout's 15 minutes, a lens's 90 —
//! a single lens legitimately ran 46 — and 30 for the rest. A task past it is abandoned.

use std::time::Duration;

const MINUTE: u64 = 60;

/// The deadline of a task of `kind`; the default for a kind not named.
pub(crate) fn deadline_of(kind: Option<&str>) -> Duration {
    let minutes = match kind.unwrap_or_default() {
        "scout" | "recall" | "warmup" => 15,
        "lens" | "criticLens" | "extra" | "seam" => 90,
        _ => 30,
    };
    Duration::from_secs(minutes * MINUTE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_kind_has_its_phase_deadline() {
        assert_eq!(deadline_of(Some("scout")), Duration::from_secs(900));
        assert_eq!(deadline_of(Some("seam")), Duration::from_secs(5400));
        assert_eq!(deadline_of(Some("verify")), Duration::from_secs(1800));
        assert_eq!(deadline_of(None), Duration::from_secs(1800));
    }
}
