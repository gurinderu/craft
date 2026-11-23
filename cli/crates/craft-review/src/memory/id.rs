//! The memory skill's record id (`skills/memory`, "Record shape"), as `integrations/shared/memory-record-id.mjs`
//! computes it: `<kind>-` and the first 10 hex characters of sha256 of `<kind>\n<title>\n<scope>`,
//! the title trimmed, its inner whitespace collapsed and lower-cased, the scope without a leading
//! `./` or a trailing `/` (realm @nick/craft, node #222). A legacy scope carrying a line is hashed
//! as written (node #606): `split_scope_line` splits it for matching only, so two ranges of one title
//! stay two records.

use craft_store::js::JsStr;
use sha2::{Digest, Sha256};

/// A scope split from the line it carries, as `scopeLine` in `integrations/shared/memory-record-id.mjs`:
/// `path:N` and `path:N-M` (earlier runs wrote such scopes; the line belongs in `line`, node #606)
/// read as `path` and N, the start line; any other scope — one with a control character among
/// them — as it is, trimmed, with line 0. Held to the JS by `content/parity/scope-line-cases.json`.
#[must_use]
pub(crate) fn split_scope_line(scope: &str) -> (&str, u64) {
    let s = scope.js_trim();
    if super::record::has_control(scope) {
        return (s, 0);
    }
    let digits = |t: &str| (1..=9).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_digit());
    let Some((path, tail)) = s.rsplit_once(':') else {
        return (s, 0);
    };
    let start = tail
        .split_once('-')
        .map_or(tail, |(a, b)| if digits(b) { a } else { "" });
    let fit = path.ends_with(|c: char| c != ' ' && c != ':');
    match (digits(start) && fit).then(|| start.parse()) {
        Some(Ok(n)) => (path, n),
        _ => (s, 0),
    }
}

/// The id of a record of `kind` with `title` and `scope`.
#[must_use]
pub(crate) fn memory_record_id(kind: &str, title: &str, scope: &str) -> String {
    let t = title
        .js_split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    let s = scope.js_trim();
    let s = s.strip_prefix("./").unwrap_or(s).trim_end_matches('/');
    let digest = Sha256::digest(format!("{kind}\n{t}\n{s}").as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("{kind}-{}", hex.get(..10).unwrap_or(&hex))
}

#[cfg(test)]
mod tests {
    use super::{memory_record_id, split_scope_line};

    /// The cases `integrations/shared/memory-scope-line.test.mjs` holds the JS reader to.
    const CASES: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../content/parity/scope-line-cases.json"
    ));

    #[test]
    fn a_scope_that_carries_a_line_or_a_range_splits_as_the_js_reader_splits_it() {
        let cases: Vec<(String, String, u64)> = serde_json::from_str(CASES).unwrap();
        for (given, scope, line) in &cases {
            assert_eq!(
                split_scope_line(given),
                (scope.as_str(), *line),
                "{given:?}"
            );
        }
    }

    #[test]
    fn a_legacy_scope_is_hashed_as_written_so_two_ranges_are_two_ids() {
        let id = |s| memory_record_id("decision", "t", s);
        assert_ne!(id("src/a.rs:10-12"), id("src/a.rs:500-505"));
        assert_ne!(id("src/a.rs:10-12"), id("src/a.rs"));
    }

    #[test]
    fn the_id_hashes_the_normalized_kind_title_and_scope() {
        // sha256("decision\nunwrap is fine here\nsrc"), as sha256sum prints it, starts fe3066cfbb.
        let id = memory_record_id("decision", "  Unwrap  is\tFINE here ", "./src/");
        assert_eq!(id, "decision-fe3066cfbb");
    }
}
