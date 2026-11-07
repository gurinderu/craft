//! The memory skill's record id (`skills/memory`, "Record shape"), as `lib/memory-record-id.mjs`
//! computes it: `<kind>-` and the first 10 hex characters of sha256 of `<kind>\n<title>\n<scope>`,
//! the title trimmed, its inner whitespace collapsed and lower-cased, the scope without a leading
//! `./` or a trailing `/` (realm @nick/craft, node #222).

use sha2::{Digest, Sha256};

/// The id of a record of `kind` with `title` and `scope`.
#[must_use]
pub(super) fn memory_record_id(kind: &str, title: &str, scope: &str) -> String {
    let t = title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    let s = scope.trim();
    let s = s.strip_prefix("./").unwrap_or(s).trim_end_matches('/');
    let digest = Sha256::digest(format!("{kind}\n{t}\n{s}").as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("{kind}-{}", hex.get(..10).unwrap_or(&hex))
}

#[cfg(test)]
mod tests {
    use super::memory_record_id;

    #[test]
    fn the_id_hashes_the_normalized_kind_title_and_scope() {
        // sha256("decision\nunwrap is fine here\nsrc"), as sha256sum prints it, starts fe3066cfbb.
        let id = memory_record_id("decision", "  Unwrap  is\tFINE here ", "./src/");
        assert_eq!(id, "decision-fe3066cfbb");
    }
}
