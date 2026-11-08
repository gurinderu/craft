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
        .map(lens_words)
        .unwrap_or_default()
}

/// The lens names a text carries, as `lensWords`.
pub(crate) fn lens_words(s: &str) -> Vec<String> {
    s.to_lowercase()
        .split([',', ';', '|'])
        .map(|w| w.trim().to_owned())
        .filter(|w| !w.is_empty())
        .collect()
}

/// The lenses a finding names: its `lens`, each of its `sources`, its `source` (`findingLenses`).
pub(crate) fn finding_lenses(f: &Value) -> Vec<String> {
    let sources = f.get("sources").and_then(Value::as_array);
    let mut lenses = words(f.get("lens"));
    lenses.extend(sources.into_iter().flatten().flat_map(|s| words(Some(s))));
    lenses.extend(words(f.get("source")));
    lenses
}

/// Whether a lens name is a gate tool's.
pub(crate) fn is_tool_lens(l: &str) -> bool {
    TOOL_LENSES.contains(&l)
}

/// Whether `f` is a gate tool's: its `lens`, a `sources` entry or its `source` names one.
pub(crate) fn is_tool_finding(f: &Value) -> bool {
    finding_lenses(f).iter().any(|l| is_tool_lens(l))
}

/// A finding's `toolRule` as compared, as `ruleKey`.
pub(crate) fn rule_key(f: &Value) -> String {
    rule_key_of(f.get("toolRule").and_then(Value::as_str).unwrap_or(""))
}

/// A `toolRule` as compared, as `ruleKey`: folded, a leading `<tool>::` naming a gate tool dropped.
pub(crate) fn rule_key_of(rule: &str) -> String {
    let s = rule.trim().to_lowercase();
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
    title_key_of(f.get("title").and_then(Value::as_str).unwrap_or(""))
}

/// A title as compared, as `titleKey`: folded, whitespace collapsed.
pub(crate) fn title_key_of(t: &str) -> String {
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

/// Whether a source names a gate tool, as `isToolSource`: a verifier refutes its finding only by
/// running the tool again.
pub(crate) fn is_tool_source(source: &str) -> bool {
    lens_words(source).iter().any(|l| is_tool_lens(l))
}

/// The section listing each finding of a gate tool that names no rule, once, as `file:line` and
/// its title unchanged but for collapsed whitespace, as `toolTitlesSection`: such a finding is told
/// apart from a past decision by its title alone (realm @nick/craft, node #236).
#[must_use]
pub(crate) fn titles_section(findings: &[Value]) -> String {
    let mut rows: Vec<String> = Vec::new();
    for f in findings
        .iter()
        .filter(|f| is_tool_finding(f) && rule_key(f).is_empty())
    {
        let file = f
            .get("file")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        let line = f.get("line").and_then(Value::as_u64).unwrap_or(0);
        let title = f.get("title").and_then(Value::as_str).unwrap_or("");
        let row = format!(
            "- `{}:{line}` · {}",
            file.unwrap_or("?"),
            title.split_whitespace().collect::<Vec<_>>().join(" ")
        );
        if !rows.contains(&row) {
            rows.push(row);
        }
    }
    if rows.is_empty() {
        return String::new();
    }
    format!(
        "\n\n## Tool finding titles (verbatim)\n{}\n",
        rows.join("\n")
    )
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
