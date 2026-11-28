//! One finding as an entry of the report or of `unverified.md`.

use craft_review::settle::Tier;
use serde_json::Value;

pub(super) fn field<'a>(f: &'a Value, k: &str) -> &'a str {
    f.get(k).and_then(Value::as_str).unwrap_or("")
}

/// One finding as a report entry.
#[must_use]
pub fn entry(f: &Value) -> String {
    noted(f, "")
}

/// One finding as a report entry, `note` beside its severity.
fn noted(f: &Value, note: &str) -> String {
    let line = f.get("line").and_then(Value::as_i64).unwrap_or(0);
    let mut e = format!(
        "- **{}**{note} `{}:{line}` — {} ({})\n  - Why: {}\n",
        field(f, "severity"),
        field(f, "file"),
        field(f, "title"),
        field(f, "source"),
        field(f, "why").replace('\n', " "),
    );
    let fix = field(f, "fix");
    if !fix.is_empty() {
        e.push_str(&format!("  - Fix: {}\n", fix.replace('\n', " ")));
    }
    e
}

/// One finding as a report entry, saying the severity its lens rated it when its harm capped it
/// below that unverified: a Low listed among the unjudged at Medium and above.
pub(super) fn capped(f: &Value) -> String {
    let lens = field(f, "lensSeverity");
    if Tier::of(f) != Tier::Unverified || lens.is_empty() || lens == field(f, "severity") {
        return entry(f);
    }
    noted(f, &format!(" (lens: {lens}, capped by harm)"))
}
