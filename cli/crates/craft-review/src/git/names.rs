//! The changed paths that are not UTF-8, which the review leaves out whole: set apart from the
//! paths `git diff --name-only -z` prints, spelled as git's own quoting (`core.quotePath`) spells
//! them, and their sections cut out of a diff.

/// The paths of `raw`, NUL-separated, that are UTF-8; and, apart, those that are not, quoted.
pub(super) fn split(raw: &[u8]) -> (Vec<String>, Vec<String>) {
    let mut files = Vec::new();
    let mut not_utf8 = Vec::new();
    for name in raw.split(|b| *b == 0).filter(|n| !n.is_empty()) {
        if let Ok(n) = std::str::from_utf8(name) {
            files.push(n.to_owned());
        } else {
            not_utf8.push(quote(name));
        }
    }
    (files, not_utf8)
}

/// `raw`, a `git diff` with its paths unquoted, without the sections of the files whose path is not
/// UTF-8: no line of the change is read from them.
///
/// # Errors
/// When what is left is still not UTF-8 (a changed line's own bytes).
pub(super) fn without_not_utf8(raw: Vec<u8>) -> Result<String, std::string::FromUtf8Error> {
    if std::str::from_utf8(&raw).is_ok() {
        return String::from_utf8(raw);
    }
    let mut out = Vec::with_capacity(raw.len());
    let mut keep = true;
    // A changed line starts with ` `, `+` or `-`: only a section's own header starts so.
    for line in raw.split_inclusive(|b| *b == b'\n') {
        if line.starts_with(b"diff --git ") {
            keep = std::str::from_utf8(line).is_ok();
        }
        if keep {
            out.extend_from_slice(line);
        }
    }
    String::from_utf8(out)
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
