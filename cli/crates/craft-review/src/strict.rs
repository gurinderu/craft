//! Strict mode's maintainability bar, as `lib/review-run.mjs` holds it (`isMaintainability`,
//! `finalVerdict`) and `lib/review-verify-pool.mjs` spares it from the harm cap: a maintainability
//! finding keeps the severity its lens raised it to, and a confirmed one at Medium or above blocks.

use serde_json::Value;

const LENS: &str = "maintainability";

/// Whether `f` is a maintainability finding: its own source, or one merged into it by the dedup.
#[must_use]
pub(crate) fn is_maintainability(f: &Value) -> bool {
    f.get("source").and_then(Value::as_str) == Some(LENS)
        || f.get("sources")
            .and_then(Value::as_array)
            .is_some_and(|s| s.iter().any(|x| x.as_str() == Some(LENS)))
}

/// Whether, in strict mode, one of the confirmed `findings` is a maintainability finding at Medium
/// or above, which makes the verdict Block.
pub(crate) fn blocks<'a>(strict: bool, mut findings: impl Iterator<Item = &'a Value>) -> bool {
    strict
        && findings.any(|f| {
            is_maintainability(f)
                && matches!(
                    f.get("severity").and_then(Value::as_str),
                    Some("Critical" | "High" | "Medium")
                )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_merged_maintainability_finding_counts_and_only_medium_and_above_block() {
        let merged = json!({"source": "errors", "sources": ["errors", "maintainability"], "severity": "Medium"});
        assert!(is_maintainability(&merged));
        assert!(blocks(true, [&merged].into_iter()));
        assert!(!blocks(false, [&merged].into_iter()), "only in strict mode");
        let low = json!({"source": "maintainability", "severity": "Low"});
        assert!(!blocks(true, [&low].into_iter()));
        let other = json!({"source": "errors", "severity": "High"});
        assert!(!blocks(true, [&other].into_iter()));
    }
}
