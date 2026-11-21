//! A file header's path as `git diff` prints it: as it is, but ended with a tab when it holds a
//! space; C-quoted (`"b/q\"t.rs"`, a non-ASCII or control byte as `\ooo` octal) when it holds a
//! quote, a backslash or a control character, or a non-ASCII byte without `core.quotePath=false`.

/// The path of a header's rest (after `+++ ` or `--- `) without its side's `prefix`; `None` for
/// `/dev/null`, a path not under `prefix`, or a quoted one that does not close or is not UTF-8
/// (left out, as before quoted paths were read; issue #414).
pub(crate) fn header_path(rest: &str, prefix: &str) -> Option<String> {
    let path = match rest.strip_prefix('"') {
        Some(quoted) => unquote(quoted)?,
        None => rest.strip_suffix('\t').unwrap_or(rest).to_owned(),
    };
    path.strip_prefix(prefix).map(str::to_owned)
}

/// The bytes of a C-quoted string up to its closing quote, read as UTF-8; `None` when it does not
/// close or its bytes are not UTF-8.
fn unquote(s: &str) -> Option<String> {
    let mut out = Vec::new();
    let mut chars = s.chars();
    loop {
        match chars.next()? {
            '"' => return String::from_utf8(out).ok(),
            '\\' => out.push(escaped(&mut chars)?),
            c => out.extend_from_slice(c.encode_utf8(&mut [0; 4]).as_bytes()),
        }
    }
}

/// The byte an escape stands for, its backslash read: one letter, a quote or a backslash, or
/// three octal digits; `None` for any other.
fn escaped(chars: &mut std::str::Chars<'_>) -> Option<u8> {
    let byte = match chars.next()? {
        'a' => 0x07,
        'b' => 0x08,
        't' => b'\t',
        'n' => b'\n',
        'v' => 0x0b,
        'f' => 0x0c,
        'r' => b'\r',
        d @ '0'..='3' => {
            let digit = |c: char| c.to_digit(8);
            let (hi, mid, lo) = (digit(d)?, digit(chars.next()?)?, digit(chars.next()?)?);
            u8::try_from(hi * 64 + mid * 8 + lo).ok()?
        }
        '\\' => b'\\',
        '"' => b'"',
        _ => return None,
    };
    Some(byte)
}

#[cfg(test)]
mod tests {
    use super::header_path;

    #[test]
    fn a_path_is_read_bare_tabbed_or_quoted() {
        assert_eq!(header_path("b/src/a.rs", "b/").as_deref(), Some("src/a.rs"));
        assert_eq!(
            header_path("b/my dir/x.rs\t", "b/").as_deref(),
            Some("my dir/x.rs")
        );
        assert_eq!(
            header_path(r#""b/q\"t\\\t\303\251.rs""#, "b/").as_deref(),
            Some("q\"t\\\té.rs")
        );
        assert_eq!(header_path("/dev/null", "b/"), None);
        assert_eq!(header_path(r#""b/open"#, "b/"), None);
        assert_eq!(header_path(r#""b/bad\9.rs""#, "b/"), None);
        assert_eq!(header_path(r#""b/\377.rs""#, "b/"), None);
    }
}
