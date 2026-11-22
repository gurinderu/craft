//! The memory skill's record id (`skills/memory`, "Record shape"), as `integrations/shared/memory-record-id.mjs`
//! computes it: `<kind>-` and the first 10 hex characters of sha256 of `<kind>\n<title>\n<scope>`,
//! the title trimmed, its inner whitespace collapsed and lower-cased, the scope without a leading
//! `./` or a trailing `/` (realm @nick/craft, node #222), and without a line the scope carries
//! (`split_scope_line`, node #598): the same fact has the same id however its scope was written.

use sha2::{Digest, Sha256};

/// A scope split from the line it carries, as `scopeLine` in `integrations/shared/memory-record-id.mjs`:
/// `path:N` and `path:N-M` (earlier runs wrote such scopes; the line belongs in `line`, node #598)
/// read as `path` and N, the start line; any other scope as it is, trimmed, with line 0.
#[must_use]
pub(super) fn split_scope_line(scope: &str) -> (&str, u64) {
    let s = scope.trim();
    let digits = |t: &str| (1..=9).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_digit());
    let Some((path, tail)) = s.rsplit_once(':') else {
        return (s, 0);
    };
    let start = tail
        .split_once('-')
        .map_or(tail, |(a, b)| if digits(b) { a } else { "" });
    let fit = path.ends_with(|c: char| !c.is_whitespace() && c != ':');
    match (digits(start) && fit).then(|| start.parse()) {
        Some(Ok(n)) => (path, n),
        _ => (s, 0),
    }
}

/// The id of a record of `kind` with `title` and `scope`.
#[must_use]
pub(super) fn memory_record_id(kind: &str, title: &str, scope: &str) -> String {
    let t = title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    let s = split_scope_line(scope).0;
    let s = s.strip_prefix("./").unwrap_or(s).trim_end_matches('/');
    let digest = Sha256::digest(format!("{kind}\n{t}\n{s}").as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("{kind}-{}", hex.get(..10).unwrap_or(&hex))
}

#[cfg(test)]
mod tests {
    use super::{memory_record_id, split_scope_line};

    #[test]
    fn a_scope_that_carries_a_line_or_a_range_splits_into_the_path_and_its_start_line() {
        let read = |s| split_scope_line(s);
        assert_eq!(read(" src/users.rs:1230-1245 "), ("src/users.rs", 1230));
        assert_eq!(read("src/users.rs:42"), ("src/users.rs", 42));
        for kept in [
            "src/users.rs",
            ".",
            "src:",
            ":12",
            "src/a.rs:x",
            "src/a.rs:1-x",
            "src/a.rs::3",
            "a:1234567890",
        ] {
            assert_eq!(read(kept), (kept, 0), "{kept}");
        }
        let id = |s| memory_record_id("decision", "t", s);
        assert_eq!(id("src/users.rs:1230-1245"), id("src/users.rs"));
        assert_eq!(id("./src/users.rs:7"), id("src/users.rs"));
    }

    #[test]
    fn the_id_hashes_the_normalized_kind_title_and_scope() {
        // sha256("decision\nunwrap is fine here\nsrc"), as sha256sum prints it, starts fe3066cfbb.
        let id = memory_record_id("decision", "  Unwrap  is\tFINE here ", "./src/");
        assert_eq!(id, "decision-fe3066cfbb");
    }
}
