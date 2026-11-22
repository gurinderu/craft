use super::lines::Document;

pub(super) const BARE: &str = r#"([^"'\s#@]+)"#;
pub(super) const VERSION: &str = r#"["']?([^"'\s#@]+)"#;

pub(super) fn escape(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if ".*+?^${}()|[]\\".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn exact(rest: &str) -> String {
    format!(r"^[ \t]*(?:-[ \t]+)?{}", escape(rest))
}

pub(super) fn inline(prefix: &str) -> String {
    format!("{}{BARE}", exact(prefix))
}

fn pair_of(rest: &str, version: &str, between: &str, after: bool) -> String {
    if after {
        format!(r"{}[ \t\r]*\n{between}{version}", exact(rest))
    } else {
        format!(r"{version}[^\n]*\n{between}{}[ \t\r]*$", exact(rest))
    }
}

pub(in super::super) fn pair(doc: &Document<'_>, a: usize, v: usize, key: &str) -> String {
    let (Some(anchor), Some(version)) = (doc.key(a), doc.key(v)) else {
        return String::new();
    };
    let gap = v.abs_diff(a).saturating_sub(1);
    let indent = doc
        .lines
        .get(v)
        .and_then(|l| l.raw.get(..version.col))
        .unwrap_or("");
    let version = format!(r"^{}{}:[ \t]*{VERSION}", escape(indent), escape(key));
    let col = if anchor.col == 0 {
        String::new()
    } else {
        format!(r"[ \t]{{{}}}", anchor.col)
    };
    let between = format!(
        r"(?:(?:{col}[^\n]*|[ \t]*(?:#[^\n]*)?\r?)\n){{0,{}}}?",
        gap + 8
    );
    let bounded = pair_of(&anchor.rest, &version, &between, v > a);
    if bounded.encode_utf16().count() <= 200 {
        return bounded;
    }
    let version = format!(r"^[ \t]*(?:-[ \t]+)?{}:[ \t]*{VERSION}", escape(key));
    let between = if gap == 0 {
        String::new()
    } else {
        format!(r"(?:[^\n]*\n){{{gap}}}")
    };
    pair_of(&anchor.rest, &version, &between, v > a)
}
