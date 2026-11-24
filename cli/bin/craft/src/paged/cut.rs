//! Where a page of a step starts and ends: offsets in UTF-16 code units, as the driver's strings
//! count them, on character boundaries, and not next to whitespace or U+FEFF a copy could trim
//! wherever the page has another boundary; a page with none ends at its bound.

/// How many UTF-16 code units a page holds at most.
pub(super) const PAGE_UNITS: usize = 8000;

/// How many UTF-16 code units `text` is.
pub(super) fn units(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// The byte index of the UTF-16 offset `at` in `text`, `None` when it falls inside a character or
/// past the end.
pub(super) fn byte_at(text: &str, at: usize) -> Option<usize> {
    let mut seen = 0;
    for (byte, c) in text.char_indices() {
        if seen == at {
            return Some(byte);
        }
        seen += c.len_utf16();
    }
    (seen == at).then_some(text.len())
}

/// Whether a JavaScript `trim` would take `c` off a line's end: whitespace, or U+FEFF.
fn trimmed(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// The page `rest` starts with: all of it when it fits, else at most [`PAGE_UNITS`] whole
/// characters, ended where neither side of the cut is whitespace or U+FEFF — a copy that trims a
/// line's ends would lose it — unless the page has no such place, when it ends at the bound.
pub(super) fn page(rest: &str) -> &str {
    let mut ends = Vec::new();
    let mut used = 0;
    for (byte, c) in rest.char_indices() {
        if used + c.len_utf16() > PAGE_UNITS {
            break;
        }
        used += c.len_utf16();
        ends.push(byte + c.len_utf8());
    }
    let whole = ends.last().copied().unwrap_or_default();
    if whole == rest.len() {
        return rest;
    }
    let clean = |end: &usize| {
        let before = rest.get(..*end).and_then(|s| s.chars().last());
        let after = rest.get(*end..).and_then(|s| s.chars().next());
        !before.is_some_and(trimmed) && !after.is_some_and(trimmed)
    };
    let end = ends
        .iter()
        .rev()
        .find(|e| clean(e))
        .copied()
        .unwrap_or(whole);
    rest.get(..end).unwrap_or(rest)
}
