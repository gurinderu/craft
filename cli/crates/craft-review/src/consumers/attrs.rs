//! Whether a declaration is test code: a test attribute on it — read whole, over the lines a
//! multi-line attribute spans, matched by its path — or a `#[cfg(test)]` module around it.

use super::braces::item_end;

/// The last path segments of the attributes that make an item a test.
const TEST_ATTRS: [&str; 3] = ["test", "test_case", "rstest"];

/// Whether the declaration at `at` (0-based) is test code: carries a test attribute, or sits in
/// one of `test_mods`, the file's test modules ([`test_mods`]).
pub(super) fn is_test(
    lines: &[&str],
    st: &[Vec<u8>],
    test_mods: &[(usize, usize)],
    at: usize,
) -> bool {
    has_test_attr(lines, st, at) || test_mods.iter().any(|&(d, end)| d < at && at <= end)
}

/// Whether the attributes above the declaration at `at` hold a test attribute.
fn has_test_attr(lines: &[&str], st: &[Vec<u8>], at: usize) -> bool {
    let start = attrs_start(lines, st, at);
    let text = lines.get(start..at).unwrap_or_default().join("\n");
    text.split("#[").skip(1).any(is_test_attr)
}

/// The first line of the attributes and doc comments right above `at`: a line is theirs when it
/// opens with `#[` or `//`, or sits inside an attribute that closes below it.
fn attrs_start(lines: &[&str], st: &[Vec<u8>], at: usize) -> usize {
    let mut start = at;
    let mut open = 0i32;
    for i in (0..at).rev() {
        let t = lines.get(i).map_or("", |l| l.trim_start());
        let balance = st.get(i).map_or(0, |s| closers(s));
        let ends_attr = t.trim_end().ends_with(']');
        let takes = open > 0 || t.starts_with("#[") || t.starts_with("//") || ends_attr;
        if !takes {
            break;
        }
        open += balance;
        if open <= 0 {
            open = 0;
            if !t.starts_with("#[") && !t.starts_with("//") {
                break;
            }
            start = i;
        }
    }
    start
}

/// How many more brackets `line` closes than it opens.
fn closers(line: &[u8]) -> i32 {
    line.iter()
        .map(|c| match c {
            b')' | b']' | b'}' => 1,
            b'(' | b'[' | b'{' => -1,
            _ => 0,
        })
        .sum()
}

/// Whether the attribute whose text follows `#[` is a test one: its path's last segment one of
/// [`TEST_ATTRS`], or `cfg(test)`.
fn is_test_attr(body: &str) -> bool {
    let body = body.trim_start();
    let path_len = body
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == ':'))
        .unwrap_or(body.len());
    let path = body.get(..path_len).unwrap_or_default();
    let last = path.rsplit("::").next().unwrap_or(path);
    if TEST_ATTRS.contains(&last) {
        return true;
    }
    let rest: String = body
        .get(path_len..)
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    path == "cfg" && rest.starts_with("(test)]")
}

/// The spans (first and last line, 0-based) of the file's inline modules whose attributes hold
/// `#[cfg(test)]` (or a test attribute), read once per file.
pub(super) fn test_mods(lines: &[&str], st: &[Vec<u8>]) -> Vec<(usize, usize)> {
    lines
        .iter()
        .enumerate()
        .filter(|&(d, l)| is_mod(l) && has_test_attr(lines, st, d))
        .filter_map(|(d, _)| Some((d, item_end(st, d)?)))
        .collect()
}

/// Whether `line` opens an inline module: `mod name {`, with any visibility.
fn is_mod(line: &str) -> bool {
    let t = line.trim_start();
    let t = t.strip_prefix("pub").map_or(t, |r| {
        r.trim_start()
            .strip_prefix('(')
            .and_then(|r| r.split_once(')'))
            .map_or(r, |(_, r)| r)
    });
    t.trim_start()
        .strip_prefix("mod ")
        .is_some_and(|r| r.contains('{'))
}
