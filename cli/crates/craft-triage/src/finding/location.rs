//! The file and line a gathered location names, as `locationParts` in
//! `integrations/shared/triage-sift.mjs` reads them.

use craft_store::js::{JsStr, is_space};

/// `s` as `^(\S+?):(\d+)(?:[-:]\d+)?$` splits it (JavaScript's `\S` and its ASCII `\d`): the
/// leftmost colon whose rest is digits, then at most one `-` or `:` and digits.
fn at_line(s: &str) -> Option<(&str, &str)> {
    let digits = |t: &str| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit());
    if s.chars().any(is_space) {
        return None;
    }
    s.match_indices(':')
        .map(|(i, _)| i)
        .filter(|&i| i > 0)
        .find_map(|i| {
            let (file, rest) = (s.get(..i)?, s.get(i + 1..)?);
            let line = rest
                .find(['-', ':'])
                .map_or(rest, |j| rest.get(..j).unwrap_or(rest));
            let tail = rest.get(line.len()..).unwrap_or("");
            let tail_ok = tail.is_empty() || tail.get(1..).is_some_and(digits);
            (digits(line) && tail_ok).then_some((file, line))
        })
}

/// The file and line a location names: `path:line` (a `:col` or `-end` after it ignored); a bare
/// path (`^\S+[./]\S*$`) keeps line 0; a PR-level or empty location names no file. A line past
/// `u64` reads as `u64::MAX`.
#[must_use]
pub fn location_parts(location: &str) -> (String, u64) {
    let s = location.js_trim();
    if let Some((file, line)) = at_line(s) {
        return (file.to_owned(), line.parse().unwrap_or(u64::MAX));
    }
    let is_path = !s.chars().any(is_space)
        && s.char_indices()
            .any(|(i, c)| i > 0 && (c == '.' || c == '/'));
    (if is_path { s.to_owned() } else { String::new() }, 0)
}
