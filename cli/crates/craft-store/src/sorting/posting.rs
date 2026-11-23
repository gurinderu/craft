//! The PR `craft review post` is about to post a doubtful finding on, written into that finding's
//! choice before the post (`{ pr, posting: true, at }`), so a retry after a post whose outcome is
//! unknown names the same PR rather than guessing one; the choice written once the post landed
//! keeps it ([`super::apply_choice`]).

use std::path::Path;

use crate::js::{Js, JsString, Obj};

/// Why a record refuses the mark: what was asked is not in it.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Refusal {
    /// The record carries no sorting.
    #[error("the record carries no sorting")]
    NoSorting,
    /// The record lists no doubtful finding of that number (as JavaScript prints it).
    #[error("the record lists no doubtful finding numbered {0}")]
    NoFinding(String),
}

/// Why a finding could not be marked as being posted: its record refused it, or the record could
/// not be read, locked or written.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MarkError {
    /// The record refused the mark.
    #[error("{file}: {refusal}")]
    Refused {
        file: String,
        #[source]
        refusal: Refusal,
    },
    /// Reading, locking or writing the record failed.
    #[error("{0}")]
    Failed(String),
}

impl MarkError {
    /// Whether the record refused the mark, rather than failing to be read or written.
    #[must_use]
    pub fn is_refusal(&self) -> bool {
        matches!(self, Self::Refused { .. })
    }
}

/// The record with doubtful finding `n`'s choice marked as being posted on the PR `pr` at `at`, over
/// what the entry held.
///
/// # Errors
/// When the record carries no sorting or lists no finding numbered `n`.
pub fn apply(record: &Obj, n: f64, pr: u64, at: &str) -> Result<Obj, Refusal> {
    let Some(sorting) = record.get("sorting").and_then(Js::as_obj) else {
        return Err(Refusal::NoSorting);
    };
    if !super::sorted_findings(record)
        .iter()
        .any(|f| crate::publication::js_number(f.get("n")) - n == 0.0)
    {
        return Err(Refusal::NoFinding(crate::js::number_text(n)));
    }
    let mut choices = super::choices_of(sorting);
    // Merged into the finding's entry: a choice made before (a drop, an earlier question)
    // survives a post that then fails.
    let key = JsString::from(crate::js::number_text(n));
    let mut mine = match choices.get(&key) {
        Some(Js::Obj(o)) => o.clone(),
        _ => Obj::new(),
    };
    #[expect(clippy::cast_precision_loss, reason = "a PR number, far below 2^53")]
    mine.set("pr", Js::Num(pr as f64));
    mine.set("posting", Js::Bool(true));
    mine.set("at", Js::str(at));
    choices.set(key, Js::Obj(mine));
    let mut sorting = sorting.clone();
    sorting.set("choices", Js::Obj(choices));
    let mut out = record.clone();
    out.set("sorting", Js::Obj(sorting));
    Ok(out)
}

/// Marks doubtful finding `n` of `file` as being posted on PR `pr`, under `store`'s lock when the
/// file lies inside it.
///
/// # Errors
/// [`MarkError::Refused`] when the record carries no sorting or lists no finding numbered `n`;
/// [`MarkError::Failed`] when it cannot be read, locked or written.
pub fn mark(store: &Path, file: &Path, n: f64, pr: u64, now_ms: i64) -> Result<(), MarkError> {
    let at = crate::time::iso(now_ms);
    let inside = crate::checkpoint::contains_path(store, file).then_some(store);
    let mut refused = None;
    let done = crate::amend::rewrite(inside, &[file], &mut |_, record| {
        apply(&record, n, pr, &at).map_err(|refusal| {
            let why = refusal.to_string();
            refused = Some(refusal);
            why
        })
    });
    match (done, refused) {
        (Ok(_), _) => Ok(()),
        (Err(_), Some(refusal)) => Err(MarkError::Refused {
            file: file.display().to_string(),
            refusal,
        }),
        (Err(why), None) => Err(MarkError::Failed(why)),
    }
}

/// The PR doubtful finding `n`'s choice in `record` names, when it names one.
#[must_use]
pub fn recorded_pr(record: &serde_json::Value, n: u64) -> Option<u64> {
    record
        .get("sorting")?
        .get("choices")?
        .get(n.to_string())?
        .get("pr")?
        .as_u64()
        .filter(|&p| p > 0)
}
