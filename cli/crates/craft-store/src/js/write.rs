//! `JSON.stringify`, compact and with an indent of two: a number JSON cannot hold is `null`, a
//! string escapes `"`, `\` and the control characters as JavaScript escapes them.

use super::{Js, JsString, number_text};

pub(super) fn compact(v: &Js) -> String {
    let mut out = String::new();
    put(&mut out, v, None, 0);
    out
}

pub(super) fn pretty(v: &Js) -> String {
    let mut out = String::new();
    put(&mut out, v, Some("  "), 0);
    out
}

fn put(out: &mut String, v: &Js, indent: Option<&str>, depth: usize) {
    match v {
        Js::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Js::Num(n) if n.is_finite() => out.push_str(&number_text(*n)),
        Js::Null | Js::Num(_) => out.push_str("null"),
        Js::Str(s) => quote(out, s.units()),
        Js::Arr(a) => {
            let items = a.iter().map(|x| (None, x));
            container(out, ('[', ']'), items, indent, depth);
        }
        Js::Obj(o) => {
            let items = o.iter().map(|(k, x)| (Some(k), x));
            container(out, ('{', '}'), items, indent, depth);
        }
    }
}

fn container<'a>(
    out: &mut String,
    (open, close): (char, char),
    items: impl ExactSizeIterator<Item = (Option<&'a JsString>, &'a Js)>,
    indent: Option<&str>,
    depth: usize,
) {
    out.push(open);
    let empty = items.len() == 0;
    for (i, (key, item)) in items.enumerate() {
        if i > 0 {
            out.push(',');
        }
        if let Some(ind) = indent {
            out.push('\n');
            out.push_str(&ind.repeat(depth + 1));
        }
        if let Some(k) = key {
            quote(out, k.units());
            out.push(':');
            if indent.is_some() {
                out.push(' ');
            }
        }
        put(out, item, indent, depth + 1);
    }
    if let (Some(ind), false) = (indent, empty) {
        out.push('\n');
        out.push_str(&ind.repeat(depth));
    }
    out.push(close);
}

fn quote(out: &mut String, units: impl Iterator<Item = u16>) {
    out.push('"');
    for c in char::decode_utf16(units) {
        match c {
            Ok(c) => quote_char(out, c),
            Err(e) => out.push_str(&format!("\\u{:04x}", e.unpaired_surrogate())),
        }
    }
    out.push('"');
}

fn quote_char(out: &mut String, c: char) {
    match c {
        '"' => out.push_str("\\\""),
        '\\' => out.push_str("\\\\"),
        '\u{8}' => out.push_str("\\b"),
        '\u{c}' => out.push_str("\\f"),
        '\n' => out.push_str("\\n"),
        '\r' => out.push_str("\\r"),
        '\t' => out.push_str("\\t"),
        c if u32::from(c) < 0x20 => {
            out.push_str(&format!("\\u{:04x}", u32::from(c)));
        }
        c => out.push(c),
    }
}
