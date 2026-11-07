//! A gate tool's finding and its own identity, as `lib/prior-decision-match.mjs` reads them
//! (`isToolFinding`, `ruleKey`, `titleKey`, `toolDistinct`; realm @nick/craft, nodes #236, #238):
//! two findings a tool tells apart are never one finding, whatever key they share.

use serde_json::Value;

/// The sources a gate tool's seed carries, as `TOOL_LENSES`.
const TOOL_LENSES: [&str; 9] = [
    "tool",
    "clippy",
    "clippy-pedantic",
    "semgrep",
    "semver",
    "semver-checks",
    "statix",
    "deadnix",
    "fmt",
];

/// The lens names a value carries, as `lensWords`: split on `,`, `;` and `|`, folded.
fn words(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_str)
        .map(|s| {
            s.to_lowercase()
                .split([',', ';', '|'])
                .map(|w| w.trim().to_owned())
                .filter(|w| !w.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Whether `f` is a gate tool's: its `lens`, a `sources` entry or its `source` names one.
fn is_tool_finding(f: &Value) -> bool {
    let sources = f.get("sources").and_then(Value::as_array);
    let mut lenses = words(f.get("lens"));
    lenses.extend(sources.into_iter().flatten().flat_map(|s| words(Some(s))));
    lenses.extend(words(f.get("source")));
    lenses.iter().any(|l| TOOL_LENSES.contains(&l.as_str()))
}

/// A `toolRule` as compared, as `ruleKey`: folded, a leading `<tool>::` naming a gate tool dropped.
fn rule_key(f: &Value) -> String {
    let s = f
        .get("toolRule")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let Some((tool, rule)) = s.split_once("::") else {
        return s;
    };
    let (tool, rule) = (tool.trim(), rule.trim());
    let named = !tool.is_empty()
        && tool
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        && TOOL_LENSES
            .iter()
            .any(|l| *l == tool || l.split('-').next() == Some(tool));
    if named && !rule.is_empty() {
        rule.to_owned()
    } else {
        s
    }
}

/// A title as compared, as `titleKey`: folded, whitespace collapsed.
fn title_key(f: &Value) -> String {
    let t = f.get("title").and_then(Value::as_str).unwrap_or("");
    t.to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Whether two gate-tool findings are distinct by the tool's own identity, as `toolDistinct`: both
/// carry a rule and they differ, or neither names one and their titles differ (a deadnix binding).
#[must_use]
pub fn distinct(a: &Value, b: &Value) -> bool {
    if !is_tool_finding(a) || !is_tool_finding(b) {
        return false;
    }
    let (ra, rb) = (rule_key(a), rule_key(b));
    if !ra.is_empty() && !rb.is_empty() {
        return ra != rb;
    }
    ra.is_empty() && rb.is_empty() && title_key(a) != title_key(b)
}

#[cfg(test)]
mod tests {
    use super::distinct;
    use serde_json::json;

    #[test]
    fn only_a_tool_tells_its_findings_apart() {
        let f = |src: &str, rule: &str, title: &str| json!({"source": src, "toolRule": rule, "title": title});
        assert!(distinct(
            &f("clippy", "clippy::a", "x"),
            &f("clippy", "b", "x")
        ));
        assert!(!distinct(
            &f("clippy", "Clippy::A", "x"),
            &f("clippy", "a", "y")
        ));
        assert!(distinct(
            &f("deadnix", "", "Unused: pkgs"),
            &f("deadnix", "", "Unused: self")
        ));
        assert!(!distinct(
            &f("deadnix", "", "Unused:  PKGS"),
            &f("deadnix", "", "unused: pkgs")
        ));
        assert!(
            !distinct(&f("errors", "a", "x"), &f("errors", "b", "x")),
            "a lens finding is no tool's"
        );
    }
}
