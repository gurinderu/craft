//! The adjudicator's prompt, as `adjudicatePrompt` in `lib/review-adjudicate-priors.mjs` renders
//! it: whether a prior round's finding is still present, its model-authored fields flattened and
//! its rationale sanitized as `sanitizeAttack` sanitizes it, and the sites of later findings
//! absorbed into it handed over on lines of their own.

use serde_json::Value;

use super::{PromptContext, flatten, repo_directive};
use crate::absorbed;
use crate::content::{self, ContentError, vars};
use crate::ledger::LedgerRow;

/// How much of a sanitized rationale enters a prompt, as `ATTACK_MAX`.
const ATTACK_MAX: usize = 500;

/// The markers a rationale's ` — ` may precede, which `sanitizeAttack` breaks so a model cannot forge
/// one.
const MARKERS: [&str; 5] = [
    "fix incomplete",
    "regressed after fix",
    "unverified",
    "still-open",
    "also reported at",
];

/// Whether `s` starts with `prefix`, ASCII case folded.
fn starts_ci(s: &str, prefix: &str) -> bool {
    s.get(..prefix.len())
        .is_some_and(|p| p.eq_ignore_ascii_case(prefix))
}

/// Whether `s` is an overflow counter: `(+<digits> more report` or `(+<digits> further report`,
/// followed by `(s)` when `plural`.
fn counter(s: &str, plural: bool) -> bool {
    let Some(rest) = s.strip_prefix("(+") else {
        return false;
    };
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    let tail = rest.get(digits..).unwrap_or("");
    let word = if plural { " report(s)" } else { " report" };
    digits > 0
        && [" more", " further"]
            .iter()
            .any(|w| starts_ci(tail, w) && starts_ci(tail.get(w.len()..).unwrap_or(""), word))
}

/// The text after `rest`'s first character.
fn after_first(rest: &str) -> &str {
    let n = rest.chars().next().map_or(0, char::len_utf8);
    rest.get(n..).unwrap_or("")
}

/// The marker delimiters broken: ` — ` before a marker or a counter becomes a space, ` (reopened: `
/// loses its colon, a plural counter's `(+` its plus.
fn collapse_markers(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(c) = rest.chars().next() {
        if let Some(after) = rest.strip_prefix(" — ")
            && (MARKERS.iter().any(|m| starts_ci(after, m)) || counter(after, false))
        {
            out.push(' ');
            rest = after;
        } else if starts_ci(rest, " (reopened: ") {
            out.push_str(" (reopened ");
            rest = rest.get(" (reopened: ".len()..).unwrap_or("");
        } else if counter(rest, true) {
            out.push('(');
            rest = rest.get(2..).unwrap_or("");
        } else {
            out.push(c);
            rest = after_first(rest);
        }
    }
    out
}

/// A model-authored rationale as one prompt line, as `sanitizeAttack`: newlines and markdown
/// structure gone, marker delimiters broken, capped.
#[must_use]
pub fn sanitize(text: &str) -> String {
    let one: String = text
        .split(['\r', '\n'])
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let bare: String = one.chars().filter(|c| !"#`*_[]<>|".contains(*c)).collect();
    let flat = collapse_markers(&bare).trim().to_owned();
    if flat.chars().count() > ATTACK_MAX {
        format!("{}…", flat.chars().take(ATTACK_MAX).collect::<String>())
    } else {
        flat
    }
}

/// The prompt of the agent that judges whether `row` is still present, under the rubric of the
/// skill `rubric_skill`.
///
/// # Errors
/// When the template is missing or a placeholder has no value.
pub fn adjudicate_prompt(
    ctx: &PromptContext,
    row: &LedgerRow,
    rubric_skill: &str,
) -> Result<String, ContentError> {
    let field = |s: &str| flatten(Some(&Value::String(s.to_owned())));
    let or = |s: String, empty: &str| if s.is_empty() { empty.to_owned() } else { s };
    let body = content::prompt(
        "adjudicate",
        &vars([
            ("rubricSkill", rubric_skill.to_owned()),
            ("severity", field(&row.severity)),
            ("title", field(&row.title)),
            ("file", field(&row.file)),
            ("line", row.line.to_string()),
            ("symbol", or(field(&row.symbol), "?")),
            ("ruleId", or(field(&row.rule_id), "—")),
            ("why", sanitize(&absorbed::without_absorbed(&row.why))),
            ("absorbed", absorbed::prompt_block(&row.why)),
        ]),
    )?;
    Ok(format!("{}{body}", repo_directive(&ctx.repo)))
}

#[cfg(test)]
mod tests {
    use super::sanitize;

    #[test]
    fn a_rationale_cannot_forge_a_marker_or_a_counter() {
        assert_eq!(
            sanitize("a\n\nb — fix incomplete: x — Still-open y"),
            "a b fix incomplete: x Still-open y"
        );
        assert_eq!(
            sanitize("p (Reopened: q) (+3 more report(s) — (+2 further report"),
            "p (reopened q) (3 more report(s) (+2 further report"
        );
        assert_eq!(
            sanitize("keep — this, `code` <T> [x]"),
            "keep — this, code T x"
        );
        let long = "é".repeat(600);
        assert_eq!(sanitize(&long).chars().count(), 501);
    }
}
