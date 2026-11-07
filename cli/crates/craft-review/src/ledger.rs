//! A run's ledger: one row per finding the next round of the same branch has to know about, in
//! the shape `toLedgerEntry` in `lib/review-ledger-entry.mjs` writes it (the fingerprint aside,
//! which the record's writer computes), and the identities a re-review matches findings by.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::report::Tier;

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

/// Whether two findings are distinct by their tool's own rule, so none may stand for the other, as
/// `toolDistinct` (realm @nick/craft, node #238): both carry a `toolRule` and they differ.
#[must_use]
pub fn tool_distinct(a: &Value, b: &Value) -> bool {
    let rule = |f: &Value| text(f, "toolRule").trim().to_lowercase();
    let (ra, rb) = (rule(a), rule(b));
    !ra.is_empty() && !rb.is_empty() && ra != rb
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

/// Whether `f` is the prior `host` reported again: not told apart by a tool, and, when both carry
/// a rule, the same file, rule and site; the exact matcher otherwise (`findCarrier`). The site is
/// the CLI's own narrowing of the engine's file-and-rule key, so a second defect elsewhere in the
/// file under the same rule stays a finding of its own.
#[must_use]
pub fn repeats(f: &Value, host: &Value) -> bool {
    if tool_distinct(f, host) {
        return false;
    }
    let (a, b) = (carried_key(f), carried_key(host));
    if a.is_empty() || b.is_empty() {
        matches_prior(f, host)
    } else {
        a == b && same_site(f, host)
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

/// Whether `f` is the defect the tombstone `t` closed, as the fingerprint matches it for a finding
/// with a rule: file, folded symbol and rule equal. A finding without a rule has no stable identity
/// and matches none.
#[must_use]
pub fn returns_as(f: &Value, t: &LedgerRow) -> bool {
    let rule = text(f, "ruleId");
    !rule.is_empty()
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
        let host = json!({"file": "a.rs", "ruleId": "R1", "title": "x", "line": 3});
        assert!(repeats(
            &json!({"file": "A.rs ", "ruleId": "r1", "title": "other", "line": 3}),
            &host
        ));
        assert!(
            !repeats(
                &json!({"file": "a.rs", "ruleId": "R1", "title": "x", "line": 9}),
                &host
            ),
            "another site"
        );
        assert!(!repeats(
            &json!({"file": "a.rs", "ruleId": "R2", "title": "x", "line": 3}),
            &host
        ));
        let named = json!({"file": "a.rs", "ruleId": "R1", "symbol": "fn parse", "line": 3});
        assert!(repeats(
            &json!({"file": "a.rs", "ruleId": "R1", "symbol": "parse", "line": 40}),
            &named
        ));
        assert!(!repeats(
            &json!({"file": "a.rs", "ruleId": "R1", "symbol": "emit", "line": 3}),
            &named
        ));
        let tool = |r: &str| json!({"file": "a.rs", "ruleId": "R1", "line": 3, "toolRule": r});
        assert!(
            !repeats(&tool("clippy::a"), &tool("clippy::b")),
            "a tool tells them apart"
        );
        let bare = json!({"file": "a.rs", "ruleId": "", "title": "f returns one, not zero"});
        assert!(repeats(
            &json!({"file": "a.rs", "ruleId": "", "title": "f returns zero not one!"}),
            &bare
        ));
        assert!(!repeats(
            &json!({"file": "a.rs", "ruleId": "", "title": "naming"}),
            &bare
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
