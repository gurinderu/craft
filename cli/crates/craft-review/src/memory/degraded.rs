//! A recall that may not have read the project's memory store (realm @nick/craft, node #203): its
//! backend query failed (`queryError`) or its agent gave no answer, it read only part of what the
//! backend held (`truncated`), or the launcher's own recall was such (`--recall-degraded`). Each is
//! a bounded one-line note and makes the run's memory degraded, never read as the project having
//! none, as `integrations/shared/recall-degraded.mjs` words it.

use super::MemorySource;
use super::judge::clip;

/// The most UTF-16 units of a recall's note the run keeps, its `…` included.
pub(super) const RECALL_NOTE_MAX: usize = 300;

/// A recall's note as one line: control characters dropped, whitespace collapsed, cut to
/// [`RECALL_NOTE_MAX`]; `None` when blank.
pub(super) fn bounded(note: &str) -> Option<String> {
    let plain: String = note
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let whole = clip(&plain, RECALL_NOTE_MAX);
    let kept = if whole.ends_with('…') && whole.encode_utf16().count() > RECALL_NOTE_MAX {
        clip(&plain, RECALL_NOTE_MAX - 1)
    } else {
        whole
    };
    Some(kept).filter(|n| !n.is_empty())
}

/// The `why` of a recall whose backend query `q` may have failed; `found` when it still returned
/// records.
pub(super) fn failed_why(why: &str, q: &str, found: bool) -> String {
    let lead = if found {
        "recall partly failed"
    } else {
        "recall found nothing"
    };
    format!("{why}; {lead} — backend query may have failed: {q}")
}

impl MemorySource {
    /// Whether a recall that found nothing read none of the store it meant to: its query failed,
    /// its answer was truncated (nothing of what the backend held was read), its agent gave none,
    /// or its launcher's recall was degraded. A recall that read records beside a truncated answer
    /// or a failed call is partly read, never this.
    pub(super) fn not_read(&self) -> bool {
        self.query_error.is_some()
            || self.truncated.is_some()
            || self.recall_died.is_some()
            || self.recall_degraded.is_some()
    }

    /// The degraded notes of a recall that may not have read the store: whose backend query may
    /// have failed (all of it, or part, what it returned applied), whose agent gave no answer,
    /// that read only part of what the backend held, or whose launcher's recall was so.
    #[must_use]
    pub fn degraded_notes(&self) -> Vec<String> {
        let recalled = self.source == "recalled";
        let failed = self.query_error.as_ref().map(|q| {
            if recalled {
                format!(
                    "memory: recall partly failed — backend query may have failed: {q}; {}, others may be missing",
                    self.returned()
                )
            } else {
                format!(
                    "memory: not read — recall found nothing, backend query may have failed: {q}; {}",
                    self.applied()
                )
            }
        });
        let died = self
            .recall_died
            .as_ref()
            .map(|d| format!("memory: not read — {d}; {}", self.applied()));
        let truncated = self.truncated.as_ref().map(|t| {
            format!("memory: recall read only part of the backend's answer ({t}): the records past it were not applied")
        });
        let upstream = self.recall_degraded.as_ref().map(|d| {
            format!("memory: the launcher's recall may not have read the whole store ({d}): only the records it handed on were applied")
        });
        failed
            .into_iter()
            .chain(died)
            .chain(truncated)
            .chain(upstream)
            .collect()
    }

    /// What a partly failed recall returned and applied.
    fn returned(&self) -> String {
        match (self.count, self.externals.unwrap_or(0)) {
            (0, e) if e > 0 => format!("the {e} external system(s) it returned were read"),
            (n, _) => format!("the {n} record(s) it returned were applied"),
        }
    }

    /// What applied in place of a recall that read nothing.
    fn applied(&self) -> String {
        match self.passed {
            Some(p) if p > 0 => format!(
                "only the launcher's own records were applied ({p} accepted, less any the store's inactive records held back)"
            ),
            _ => "none of the project's decisions or rules were applied".into(),
        }
    }
}
