//! The changed paths `git diff --name-only -z` prints: each as it is, but one that is not UTF-8
//! spelled as git's own quoting (`core.quotePath`) spells it, the way the review read every
//! non-ASCII path before it listed them raw.

/// The paths of `raw`, NUL-separated; and those of them that are not UTF-8, quoted.
pub(super) fn split(raw: &[u8]) -> (Vec<String>, Vec<String>) {
    let mut files = Vec::new();
    let mut not_utf8 = Vec::new();
    for name in raw.split(|b| *b == 0).filter(|n| !n.is_empty()) {
        if let Ok(n) = std::str::from_utf8(name) {
            files.push(n.to_owned());
        } else {
            let q = quote(name);
            files.push(q.clone());
            not_utf8.push(q);
        }
    }
    (files, not_utf8)
}

/// `name` in double quotes as git's `quote_c_style` writes it under `core.quotePath`: `"` and `\`
/// escaped, the C escapes for the control characters that have one, every other byte outside
/// printable ASCII in three octal digits.
fn quote(name: &[u8]) -> String {
    let mut out = String::from("\"");
    for &b in name {
        match b {
            b'"' => out.push_str("\\\""),
            b'\\' => out.push_str("\\\\"),
            0x07 => out.push_str("\\a"),
            0x08 => out.push_str("\\b"),
            b'\t' => out.push_str("\\t"),
            b'\n' => out.push_str("\\n"),
            0x0b => out.push_str("\\v"),
            0x0c => out.push_str("\\f"),
            b'\r' => out.push_str("\\r"),
            0x20..=0x7e => out.push(char::from(b)),
            _ => out.push_str(&format!("\\{b:03o}")),
        }
    }
    out.push('"');
    out
}
