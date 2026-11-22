//! `craft runs sorting-choice`: the reviewer's later choice for one doubtful finding a review run
//! held back from its PR — asked the author, posted as a defect, not posted — written into that
//! run's own record (`sorting.choices`), as `applySortingChoice` in
//! `integrations/shared/sorting-choice.mjs` writes it (realm @nick/craft, nodes #281, #270, #39).

use std::path::{Path, PathBuf};

use crate::js::{Js, JsString, Obj, parse};

/// The choices a reviewer can make for a doubtful finding.
pub const CHOICES: [&str; 3] = ["question", "defect", "dropped"];

fn sorted_findings(r: &Obj) -> Vec<&Obj> {
    let list = r
        .get("sorting")
        .and_then(Js::as_obj)
        .and_then(|s| s.get("findings"));
    list.and_then(Js::as_arr)
        .unwrap_or(&[])
        .iter()
        .filter_map(Js::as_obj)
        .collect()
}

/// The newest review record in `store` of `project` carrying doubtful findings, when it was filed
/// on `branch` (an empty one, a detached `HEAD`, takes the newest). Detail files are named
/// `<ts>-<kind>-<name>.json`, so the name orders them by time.
///
/// # Errors
/// When there is none, or the newest is another branch's.
pub fn latest_sorted_record(store: &Path, project: &str, branch: &str) -> Result<PathBuf, String> {
    let mut names = crate::cost::entries_of(store);
    names.retain(|n| n.ends_with("-review.json"));
    for name in names.iter().rev() {
        let file = store.join(name);
        let Some(Ok(Js::Obj(r))) = std::fs::read_to_string(&file).ok().map(|t| parse(&t)) else {
            continue;
        };
        if r.get("project").and_then(Js::as_str) != Some(project) || sorted_findings(&r).is_empty()
        {
            continue;
        }
        let on = r.get("branch");
        if branch.is_empty() || on.and_then(Js::as_str) == Some(branch) {
            return Ok(file);
        }
        return Err(format!(
            "the newest review record of {project} with doubtful findings, {}, is of branch {}, not {} — name the one meant with --record",
            file.display(),
            on.map_or_else(|| "undefined".to_owned(), Js::compact),
            Js::str(branch).compact()
        ));
    }
    Err(format!(
        "no review record of {project} in {} carries doubtful findings",
        store.display()
    ))
}

/// A value in a template literal: `undefined` for what is absent.
fn templated(v: Option<&Js>) -> String {
    v.map_or_else(
        || "undefined".into(),
        |v| v.to_js_text().to_utf8().unwrap_or_default(),
    )
}

/// The record with `choice` set for doubtful finding `n` at `at` (a later choice for the same
/// finding replaces the earlier one), and how the finding is named: `<title> @ <file>:<line>`.
///
/// # Errors
/// Why it cannot be recorded: an unknown choice, a record with no sorting, no such finding.
pub fn apply_choice(record: &Obj, n: f64, choice: &str, at: &str) -> Result<(Obj, String), String> {
    if !CHOICES.contains(&choice) {
        return Err(format!(
            "--choice must be one of {}, got {}",
            CHOICES.join(", "),
            Js::str(choice).compact()
        ));
    }
    let Some(sorting) = record.get("sorting").and_then(Js::as_obj) else {
        return Err(
            "the record carries no sorting (a review run without comment, or an older engine)"
                .into(),
        );
    };
    // A stored finding is read JSON: its `n` may be a string of digits.
    let Some(finding) = sorted_findings(record)
        .into_iter()
        .find(|f| crate::publication::js_number(f.get("n")) - n == 0.0)
    else {
        return Err(format!(
            "the record lists no doubtful finding numbered {}",
            crate::js::number_text(n)
        ));
    };
    let named = format!(
        "{} @ {}:{}",
        templated(finding.get("title")),
        templated(finding.get("file")),
        templated(finding.get("line"))
    );
    let mut choices = match sorting.get("choices") {
        Some(Js::Obj(o)) => o.clone(),
        Some(Js::Arr(a)) => {
            let mut o = Obj::new();
            for (i, v) in a.iter().enumerate() {
                o.set(JsString::from(i.to_string()), v.clone());
            }
            o
        }
        _ => Obj::new(),
    };
    let mine = Obj::new()
        .with("choice", Js::str(choice))
        .with("at", Js::str(at));
    choices.set(JsString::from(crate::js::number_text(n)), Js::Obj(mine));
    let mut sorting = sorting.clone();
    sorting.set("choices", Js::Obj(choices));
    let mut out = record.clone();
    out.set("sorting", Js::Obj(sorting));
    Ok((out, named))
}

/// Records `choice` for doubtful finding `n` in `file`, under `store`'s lock when it lies inside it.
/// Returns the line it says and the warnings of the filings replayed first.
///
/// # Errors
/// As [`apply_choice`], prefixed with the file, or when the record cannot be read or written.
pub fn record_choice(
    store: &Path,
    file: &Path,
    n: f64,
    choice: &str,
    now_ms: i64,
) -> Result<(String, Vec<String>), String> {
    let at = crate::time::iso(now_ms);
    let inside = crate::checkpoint::contains_path(store, file).then_some(store);
    let mut named = String::new();
    let warned = crate::amend::rewrite(inside, &[file], &mut |_, record| {
        let (out, said) = apply_choice(&record, n, choice, &at)
            .map_err(|why| format!("{}: {why}", file.display()))?;
        named = said;
        Ok(out)
    })?;
    let line = format!(
        "recorded {choice} for doubtful finding {} ({named}) in {}",
        crate::js::number_text(n),
        file.display()
    );
    Ok((line, warned))
}

#[cfg(test)]
mod tests;
