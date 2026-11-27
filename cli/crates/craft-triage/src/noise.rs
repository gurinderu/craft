//! The validator's noise classes read back from its answer (realm @nick/craft, node #303), as
//! `triage-noise-class.mjs` (the JavaScript the binary replaced): "not this PR's" (class 1) on a real finding is a
//! deferral carried by an issue, only when the premise names the code opened at exactly the PR's
//! fork point the triage was given (node #309); "not decidable from the code" (class 5) is a
//! `needs-decision`.

use craft_store::js::{Js, JsStr, is_space};

use crate::field;
use crate::ledger::Row;

/// A validator's noise class: `Number(noise_class)` when it is an integer from 1 to 6, else 0
/// (none named, or one outside the classes).
#[must_use]
pub fn noise_class_of(v: &Row) -> u8 {
    let n = v.0.get("noise_class").map_or(f64::NAN, Js::to_js_number);
    #[expect(
        clippy::float_cmp,
        reason = "`Number.isInteger` and the class compare exactly"
    )]
    let class = (1u8..=6).find(|c| n == f64::from(*c));
    class.unwrap_or(0)
}

/// Whether two refs name one commit as given: equal, or both SHA-shaped and one a prefix of the other.
#[must_use]
pub fn same_commit(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let sha = |s: &str| (7..=64).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_hexdigit());
    if !sha(a) || !sha(b) {
        return false;
    }
    let (x, y) = (a.to_ascii_lowercase(), b.to_ascii_lowercase());
    x.starts_with(&y) || y.starts_with(&x)
}

/// The prBase class 1 is checked at, or '' when what was given is no fork point: it counts only
/// beside the validation pin `base` and different from it; `HEAD` never counts.
#[must_use]
pub fn effective_pr_base(pr_base: &str, base: &str) -> String {
    let (at, pin) = (pr_base.js_trim(), base.js_trim());
    if at.is_empty() || pin.is_empty() || at == "HEAD" || same_commit(at, pin) {
        String::new()
    } else {
        at.to_owned()
    }
}

/// What the validator is told about where class 1 must be shown.
#[must_use]
pub fn class_one_base_line(pr_base: &str) -> String {
    let at = pr_base.js_trim();
    if at.is_empty() {
        return "no prBase (the PR's fork point) was given to this triage, so it cannot be checked here — name the class all the same; a human decides it".into();
    }
    format!(
        "the PR forks from `{at}` (prBase) — open the cited code there and record in premise_checked exactly `git show {at}:<path>`; a premise naming any other ref (HEAD, the ref you validate against, a branch, a merge-base you computed) reads as unchecked and goes to a human"
    )
}

/// Whether a premise shows a file opened at exactly `r`: `git show <r>:<path>` at the start, after
/// a space, or inside backticks, quotes or parentheses.
#[must_use]
pub fn opened_at(premise: &str, r: &str) -> bool {
    let needle = format!("git show {r}:");
    let mut from = 0;
    while let Some(rel) = premise.get(from..).and_then(|p| p.find(&needle)) {
        let i = from + rel;
        let before = premise
            .get(..i)
            .and_then(|p| p.chars().next_back())
            .unwrap_or(' ');
        let after = premise
            .get(i + needle.len()..)
            .and_then(|p| p.chars().next());
        let opens = |c: char| is_space(c) || "`'\"(".contains(c);
        let closes = |c: char| is_space(c) || ":`'\")".contains(c);
        if opens(before) && after.is_some_and(|c| !closes(c)) {
            return true;
        }
        from = i + 1;
    }
    false
}

/// The verdict a noise class settles; every other verdict stands as given.
#[must_use]
pub fn classified_verdict(v: Row, pr_base: &str) -> Row {
    match noise_class_of(&v) {
        1 => not_this_prs(v, pr_base.js_trim()),
        5 => v.with("verdict", Js::str("needs-decision")),
        _ => v,
    }
}

/// The opening of the reason a class-1 claim nothing showed is handed to a human with.
const NOT_SHOWN: &str = "claimed not this PR's, but ";

/// Whether the triage settled `v`'s verdict by its noise class itself (node #303): class 5 always,
/// its verdict the class's; class 1 only where it turned the validator's verdict — a deferral with
/// an issue, or a claim nothing showed handed to a human — never a verdict it left alone.
#[must_use]
pub fn settled_by_class(v: &Row) -> bool {
    match noise_class_of(v) {
        5 => true,
        1 => v.text("action") == "issue" || v.text("reason").starts_with(NOT_SHOWN),
        _ => false,
    }
}

/// A class-1 verdict settled: a real problem shown at `pr_base` is a deferral with an issue, one
/// not shown there a human's; a `reject` or `needs-decision` stands.
#[must_use]
pub fn not_this_prs(v: Row, pr_base: &str) -> Row {
    if v.verdict() != "accept" && v.verdict() != "defer" {
        return v;
    }
    let human = |v: Row, why: String| {
        let reason = field::cat(&[format!("{why} — ").into(), field::js_text(&v.0, "reason")]);
        v.with("verdict", Js::str("needs-decision"))
            .with("reason", Js::Str(reason))
    };
    if pr_base.is_empty() {
        let why = format!("{NOT_SHOWN}no prBase (the PR's fork point) was given to check it at");
        return human(v, why);
    }
    if !opened_at(&v.text("premise_checked"), pr_base) {
        let why =
            format!("{NOT_SHOWN}nothing at the PR's fork point {pr_base} was opened to show it");
        return human(v, why);
    }
    v.with("verdict", Js::str("defer"))
        .with("action", Js::str("issue"))
}

#[cfg(test)]
mod tests;
