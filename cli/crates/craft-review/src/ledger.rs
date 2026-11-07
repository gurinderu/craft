//! A run's ledger: one row per finding the next round of the same branch has to know about, in
//! the shape `toLedgerEntry` in `lib/review-ledger-entry.mjs` writes it (the fingerprint aside,
//! which the record's writer computes), and the identities a re-review matches findings by.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::report::Tier;
use crate::tool;

/// One ledger row. `disposition` is `open` (the next round adjudicates it), `closed` (a tombstone:
/// a resolved finding kept so its return reads as a regression), or the author's own word
/// (`rejected`, `justified`, `deferred`), which the next round carries as it stands.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LedgerRow {
    pub file: String,
    pub line: i64,
    pub symbol: String,
    pub severity: String,
    pub tier: String,
    pub disposition: String,
    pub source: String,
    pub rule_id: String,
    pub title: String,
    pub why: String,
}

impl LedgerRow {
    /// A settled finding as an open row of its tier.
    #[must_use]
    pub fn open(f: &Value) -> Self {
        let text = |k: &str| f.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
        Self {
            file: text("file"),
            line: f.get("line").and_then(Value::as_i64).unwrap_or(0),
            symbol: text("symbol"),
            severity: text("severity"),
            tier: Tier::of(f).name().to_owned(),
            disposition: "open".into(),
            source: text("source"),
            rule_id: text("ruleId"),
            title: text("title"),
            why: text("why"),
        }
    }

    /// The row as a finding a report or a matcher reads.
    #[must_use]
    pub fn finding(&self) -> Value {
        serde_json::json!({
            "file": self.file, "line": self.line, "symbol": self.symbol, "severity": self.severity,
            "tier": self.tier, "source": self.source, "ruleId": self.rule_id, "title": self.title,
            "why": self.why,
        })
    }
}

fn text<'a>(f: &'a Value, k: &str) -> &'a str {
    f.get(k).and_then(Value::as_str).unwrap_or("")
}

/// A title as a sorted bag of its lowercase alphanumeric words, as `titleShingle`.
fn shingle(title: &str) -> Vec<String> {
    let mut words: Vec<String> = title
        .to_lowercase()
        .split(|c: char| !c.is_ascii_lowercase() && !c.is_ascii_digit())
        .filter(|w| !w.is_empty())
        .map(str::to_owned)
        .collect();
    words.sort();
    words
}

/// How much two titles share, as `shingleOverlap`: common words over the larger set.
fn overlap(a: &str, b: &str) -> f64 {
    let (mut sa, mut sb) = (shingle(a), shingle(b));
    sa.dedup();
    sb.dedup();
    if sa.is_empty() || sb.is_empty() {
        return 0.0;
    }
    let common = sa.iter().filter(|w| sb.contains(w)).count();
    let most = sa.len().max(sb.len());
    f64::from(u32::try_from(common).unwrap_or(u32::MAX))
        / f64::from(u32::try_from(most).unwrap_or(u32::MAX))
}

/// Whether `cur` is the same defect as `prior`, as `matchesPrior`: the same file and rule, no two
/// different symbols, titles overlapping by 0.6 or more.
#[must_use]
pub fn matches_prior(cur: &Value, prior: &Value) -> bool {
    let (cs, ps) = (text(cur, "symbol"), text(prior, "symbol"));
    text(cur, "file") == text(prior, "file")
        && text(cur, "ruleId") == text(prior, "ruleId")
        && (cs.is_empty() || ps.is_empty() || cs == ps)
        && overlap(text(cur, "title"), text(prior, "title")) >= 0.6
}

/// The coarse identity a re-review absorbs a re-reported finding by, as `carriedKey`: file and
/// rule, folded; empty when either is missing.
#[must_use]
pub fn carried_key(f: &Value) -> String {
    let file = text(f, "file").trim().to_lowercase();
    let rule = text(f, "ruleId").trim().to_lowercase();
    if file.is_empty() || rule.is_empty() {
        String::new()
    } else {
        format!("{file}\u{0}{rule}")
    }
}

/// Whether `f` sits where the prior `host` does: the same folded symbol when both name one, else
/// the same line.
fn same_site(f: &Value, host: &Value) -> bool {
    let (fs, hs) = (
        fold_symbol(text(f, "symbol")),
        fold_symbol(text(host, "symbol")),
    );
    if !fs.is_empty() && !hs.is_empty() {
        return fs == hs;
    }
    let line = |v: &Value| v.get("line").and_then(Value::as_i64).unwrap_or(0);
    line(f) > 0 && line(f) == line(host)
}

/// Whether `f` is the prior `host` reported again, as `findCarrier` matches it: never when a tool
/// tells them apart; when both carry a rule, the same file and rule; the exact matcher otherwise.
///
/// `located`: an adjudicator re-located `host` this round, so its line is where the defect is now,
/// and the CLI narrows the key to that site as well — a second defect elsewhere in the file under
/// the same rule stays a finding of its own. A prior nobody re-located (set aside by its author, or
/// its adjudicator gave no answer) still carries the line of the round that found it, which a fix
/// above it has moved; matching its line would turn its own re-report into a new finding every
/// re-scan, so it keeps the engine's file-and-rule key.
#[must_use]
pub fn repeats(f: &Value, host: &Value, located: bool) -> bool {
    if tool::distinct(f, host) {
        return false;
    }
    let (a, b) = (carried_key(f), carried_key(host));
    if a.is_empty() || b.is_empty() {
        matches_prior(f, host)
    } else {
        a == b && (!located || same_site(f, host))
    }
}

/// A symbol folded across spellings, as `normalizeSymbol`: case, the `fn`/`impl` keyword and
/// generic parameters.
fn fold_symbol(symbol: &str) -> String {
    let mut s = symbol.to_lowercase();
    for kw in ["fn ", "impl "] {
        s = s.replace(kw, "");
    }
    while let Some(open) = s.rfind('<') {
        let Some(close) = s.get(open..).and_then(|t| t.find('>')) else {
            break;
        };
        s.replace_range(open..=open + close, "");
    }
    s.trim().to_owned()
}

/// Whether `f` is the defect the tombstone `t` closed, as `flagReturningDefects` matches it: the
/// same fingerprint (file, folded symbol and rule; `fingerprint` in `lib/run-record.mjs` keys no
/// line, so without a symbol it is file and rule) and not told apart by a tool. A finding without a
/// rule has no stable identity and matches none. The match only labels a finding (REGRESSION, or a
/// re-raised dismissal); it neither moves it nor changes what the verdict counts.
#[must_use]
pub fn returns_as(f: &Value, t: &LedgerRow) -> bool {
    let rule = text(f, "ruleId");
    !rule.is_empty()
        && !tool::distinct(f, &t.finding())
        && rule == t.rule_id
        && text(f, "file") == t.file
        && fold_symbol(text(f, "symbol")) == fold_symbol(&t.symbol)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn findings_match_by_rule_site_or_by_title() {
        let moved = json!({"file": "a.rs", "ruleId": "R1", "title": "x", "line": 40});
        assert!(
            repeats(
                &json!({"file": "a.rs", "ruleId": "R1", "title": "y", "line": 52}),
                &moved,
                false
            ),
            "an unlocated prior keeps file and rule"
        );
        let host = json!({"file": "a.rs", "ruleId": "R1", "title": "x", "line": 3});
        assert!(repeats(
            &json!({"file": "A.rs ", "ruleId": "r1", "title": "other", "line": 3}),
            &host,
            true
        ));
        assert!(
            !repeats(
                &json!({"file": "a.rs", "ruleId": "R1", "title": "x", "line": 9}),
                &host,
                true
            ),
            "another site"
        );
        assert!(!repeats(
            &json!({"file": "a.rs", "ruleId": "R2", "title": "x", "line": 3}),
            &host,
            true
        ));
        let named = json!({"file": "a.rs", "ruleId": "R1", "symbol": "fn parse", "line": 3});
        assert!(repeats(
            &json!({"file": "a.rs", "ruleId": "R1", "symbol": "parse", "line": 40}),
            &named,
            true
        ));
        assert!(!repeats(
            &json!({"file": "a.rs", "ruleId": "R1", "symbol": "emit", "line": 3}),
            &named,
            true
        ));
        let tool = |r: &str| json!({"file": "a.rs", "ruleId": "R1", "line": 3, "toolRule": r, "source": "clippy"});
        assert!(
            !repeats(&tool("clippy::a"), &tool("clippy::b"), true),
            "a tool tells them apart"
        );
        let bare = json!({"file": "a.rs", "ruleId": "", "title": "f returns one, not zero"});
        assert!(repeats(
            &json!({"file": "a.rs", "ruleId": "", "title": "f returns zero not one!"}),
            &bare,
            true
        ));
        assert!(!repeats(
            &json!({"file": "a.rs", "ruleId": "", "title": "naming"}),
            &bare,
            true
        ));
    }

    #[test]
    fn a_tombstone_is_matched_by_file_rule_and_folded_symbol() {
        let t = LedgerRow {
            file: "a.rs".into(),
            rule_id: "R1".into(),
            symbol: "fn Parse<T>".into(),
            ..LedgerRow::default()
        };
        assert!(returns_as(
            &json!({"file": "a.rs", "ruleId": "R1", "symbol": "parse<Vec<u8>>"}),
            &t
        ));
        assert!(!returns_as(
            &json!({"file": "a.rs", "ruleId": "", "symbol": "parse"}),
            &t
        ));
        assert!(!returns_as(
            &json!({"file": "b.rs", "ruleId": "R1", "symbol": "parse"}),
            &t
        ));
    }
}
