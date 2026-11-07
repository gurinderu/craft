//! A prior finding's rationale and what it carries beyond it, as `lib/review-adjudicate.mjs` keeps
//! them: the marker a round appends (`baseWhy`), and the sites of later findings absorbed into the
//! prior (`absorbInto`, `splitAbsorbed`, `withoutAbsorbed`, `absorbedPromptBlock`). Absorbed is not
//! discarded: the site rides the prior's `why` into the ledger and is handed to its next
//! adjudicator, outside the capped rationale.

use serde_json::Value;

use crate::prompts::sanitize;

/// The markers a re-review appends to a prior's rationale, the latest one replacing the last.
const SUFFIXES: [&str; 4] = [
    " — fix incomplete",
    " — REGRESSED after fix",
    " — UNVERIFIED (adjudicator could not tell)",
    " — still-open (adjudicator did not run",
];

/// The mark that opens an absorbed site's clause.
const MARK: &str = " — also reported at ";
/// How many absorbed sites a prior names before the rest become a count, as `ABSORBED_MAX`.
const ABSORBED_MAX: usize = 3;
/// The caps of an absorbed site's path and title, as `ABSORB_FILE_MAX` and `ABSORB_TITLE_MAX`.
const FILE_MAX: usize = 120;
const TITLE_MAX: usize = 160;
const MORE_HEAD: &str = " — (+";
const MORE_TAIL: &str = " more report(s) at this site)";

/// The rationale without the marker an earlier round appended, as `baseWhy`.
#[must_use]
pub fn base_why(why: &str) -> &str {
    let cut = SUFFIXES.iter().filter_map(|m| why.rfind(m)).max();
    cut.and_then(|at| why.get(..at)).unwrap_or(why)
}

/// `text` sanitized and capped at `max` characters, as `clampField`.
fn clamp(text: &str, max: usize) -> String {
    let s = sanitize(text);
    if s.chars().count() > max {
        format!("{}…", s.chars().take(max).collect::<String>())
    } else {
        s
    }
}

/// An absorbed finding's site as its clause names it, as `absorbedSite`.
fn site(f: &Value) -> String {
    let text = |k: &str| f.get(k).and_then(Value::as_str).unwrap_or("");
    let file = Some(clamp(text("file"), FILE_MAX)).filter(|s| !s.is_empty());
    let title = Some(clamp(text("title"), TITLE_MAX)).filter(|s| !s.is_empty());
    format!(
        "{}:{}: {}",
        file.as_deref().unwrap_or("?"),
        f.get("line").and_then(Value::as_i64).unwrap_or(0),
        title.as_deref().unwrap_or("untitled")
    )
}

/// The overflow count `text` carries and the text without it.
fn overflow(text: &str) -> (usize, String) {
    let Some(at) = text.find(MORE_HEAD) else {
        return (0, text.to_owned());
    };
    let rest = text.get(at + MORE_HEAD.len()..).unwrap_or("");
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    let tail = rest.get(digits..).unwrap_or("");
    match (
        rest.get(..digits).map(str::parse::<usize>),
        tail.strip_prefix(MORE_TAIL),
    ) {
        (Some(Ok(n)), Some(after)) => (n, format!("{}{after}", text.get(..at).unwrap_or(""))),
        _ => (0, text.to_owned()),
    }
}

/// `base` with `f`'s site added once, the fourth and later ones as a count, as `noteAbsorbed`.
fn note(base: &str, f: &Value) -> String {
    let clause = format!("{MARK}{}", site(f));
    if base.contains(&clause) {
        return base.to_owned();
    }
    if base.matches(MARK).count() < ABSORBED_MAX {
        return format!("{base}{clause}");
    }
    let (n, rest) = overflow(base);
    format!("{rest}{MORE_HEAD}{}{MORE_TAIL}", n + 1)
}

/// The prior's rationale `why` with `f` recorded on it, ahead of the round's marker, as
/// `absorbInto`.
#[must_use]
pub fn absorb_into(why: &str, f: &Value) -> String {
    let base = base_why(why);
    format!("{}{}", note(base, f), why.get(base.len()..).unwrap_or(""))
}

/// The rationale before any absorption, the named sites and the overflow count, as
/// `splitAbsorbed`.
fn split(why: &str) -> (String, Vec<String>, usize) {
    let (more, head) = overflow(base_why(why));
    let mut parts = head.split(MARK);
    let base = parts.next().unwrap_or("").to_owned();
    let sites = parts
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .collect();
    (base, sites, more)
}

/// The rationale as a prompt gets it, the absorbed sites lifted off, as `withoutAbsorbed`.
#[must_use]
pub fn without_absorbed(why: &str) -> String {
    let (base, _, _) = split(why);
    format!("{base}{}", why.get(base_why(why).len()..).unwrap_or(""))
}

/// The prompt lines that hand the absorbed sites to an adjudicator, empty when there are none, as
/// `absorbedPromptBlock`.
#[must_use]
pub fn prompt_block(why: &str) -> String {
    let (_, sites, more) = split(why);
    if sites.is_empty() && more == 0 {
        return String::new();
    }
    let mut lines: Vec<String> = sites.iter().map(|s| format!("  - {s}")).collect();
    if more > 0 {
        lines.push(format!(
            "  - (+{more} further report(s) at this site, not named individually)"
        ));
    }
    format!(
        "\nALSO REPORTED AT THIS SITE (further defects later rounds raised at the same file+rule; they are tracked ONLY through this finding and leave the ledger when it does):\n{}\nThey are part of what you are adjudicating: \"resolved\" requires that every one of them is gone too. If any of them still stands, return \"still-open\" and cite it in `attack`.\n",
        lines.join("\n")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn at(line: i64) -> Value {
        json!({"file": "a.rs", "line": line, "title": format!("t{line}")})
    }

    #[test]
    fn a_site_lands_ahead_of_the_marker_once_and_the_fourth_becomes_a_count() {
        let why = absorb_into("base — fix incomplete: x", &at(1));
        assert_eq!(
            why,
            "base — also reported at a.rs:1: t1 — fix incomplete: x"
        );
        assert_eq!(absorb_into(&why, &at(1)), why, "the same site once");
        let full = [2, 3, 4, 5]
            .iter()
            .fold(why, |w, l| absorb_into(&w, &at(*l)));
        assert_eq!(
            full,
            "base — also reported at a.rs:1: t1 — also reported at a.rs:2: t2 — also reported at a.rs:3: t3 — (+2 more report(s) at this site) — fix incomplete: x"
        );
        assert_eq!(without_absorbed(&full), "base — fix incomplete: x");
        let block = prompt_block(&full);
        assert!(
            block.contains("  - a.rs:3: t3\n  - (+2 further report(s)"),
            "{block}"
        );
        assert_eq!(prompt_block("plain"), "");
    }
}
