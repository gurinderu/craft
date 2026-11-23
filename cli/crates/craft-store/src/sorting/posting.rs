//! The PR `craft review post` is about to post a doubtful finding on, written into that finding's
//! choice before the post (`{ pr, posting: true, at }`), so a retry after a post whose outcome is
//! unknown names the same PR rather than guessing one; the choice written once the post landed
//! keeps it ([`super::apply_choice`]).

use std::path::Path;

use crate::js::{Js, JsString, Obj};

/// The record with doubtful finding `n`'s choice set to the PR `pr` it is being posted on at `at`.
///
/// # Errors
/// When the record carries no sorting or lists no finding numbered `n`.
pub fn apply(record: &Obj, n: f64, pr: u64, at: &str) -> Result<Obj, String> {
    let Some(sorting) = record.get("sorting").and_then(Js::as_obj) else {
        return Err("the record carries no sorting".into());
    };
    if !super::sorted_findings(record)
        .iter()
        .any(|f| crate::publication::js_number(f.get("n")) - n == 0.0)
    {
        return Err(format!(
            "the record lists no doubtful finding numbered {}",
            crate::js::number_text(n)
        ));
    }
    let mut choices = match sorting.get("choices") {
        Some(Js::Obj(o)) => o.clone(),
        _ => Obj::new(),
    };
    #[expect(clippy::cast_precision_loss, reason = "a PR number, far below 2^53")]
    let mine = Obj::new()
        .with("pr", Js::Num(pr as f64))
        .with("posting", Js::Bool(true))
        .with("at", Js::str(at));
    choices.set(JsString::from(crate::js::number_text(n)), Js::Obj(mine));
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
/// When the record cannot be read, changed or written.
pub fn mark(store: &Path, file: &Path, n: f64, pr: u64, now_ms: i64) -> Result<(), String> {
    let at = crate::time::iso(now_ms);
    let inside = crate::checkpoint::contains_path(store, file).then_some(store);
    crate::amend::rewrite(inside, &[file], &mut |_, record| {
        apply(&record, n, pr, &at).map_err(|why| format!("{}: {why}", file.display()))
    })
    .map(drop)
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
