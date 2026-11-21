//! A record's derived parts as `lib/run-record.mjs` computes them: a finding's fingerprint, the
//! findings counted by severity, the record's index line and its file name.

use crate::js::{Js, JsString, Obj};

/// The logger's engine revision (`ENGINE_REVISION`), stamped on every record and checkpoint.
pub const ENGINE_REVISION: f64 = 4.0;

/// The severities, in the order the store counts them.
pub const SEVERITIES: [&str; 5] = ["Critical", "High", "Medium", "Low", "Info"];

/// `String(v || '')`.
fn or_empty(v: Option<&Js>) -> JsString {
    v.filter(|v| v.truthy())
        .map(Js::to_js_text)
        .unwrap_or_default()
}

/// JavaScript's `trim`: white space and line terminators, the byte-order mark among them.
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// `titleShingle`: the title's lower-cased words of letters and digits, sorted.
#[must_use]
pub fn title_shingle(title: &str) -> String {
    let lower = title.to_lowercase();
    let mut words: Vec<&str> = lower
        .split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit()))
        .filter(|w| !w.is_empty())
        .collect();
    words.sort_unstable();
    words.join(" ")
}

/// `normalizeSymbol`: lower-cased, with `fn `/`impl ` and every generic parameter list dropped.
#[must_use]
pub fn normalize_symbol(symbol: &str) -> String {
    let lower = symbol.to_lowercase();
    let keyword = regex::Regex::new(r"(?-u:\b)(?:fn|impl)[\s\u{feff}]+").ok();
    let generic = regex::Regex::new(r"<[^<>]*>").ok();
    let mut s = keyword.map_or(lower.clone(), |re| re.replace_all(&lower, "").into_owned());
    if let Some(re) = generic {
        loop {
            let next = re.replace_all(&s, "").into_owned();
            if next == s {
                break;
            }
            s = next;
        }
    }
    js_trim(&s).to_owned()
}

/// `fingerprint`: djb2 over the finding's file, symbol and rule — or its title's words when it
/// names no rule — as eight hex digits.
#[must_use]
pub fn fingerprint(f: Option<&Obj>) -> String {
    let get = |k: &str| f.and_then(|o| o.get(k));
    let file = or_empty(get("file"));
    let symbol = normalize_units(&or_empty(get("symbol")));
    let rule = or_empty(get("ruleId"));
    let basis = if rule.is_empty() {
        let title = title_units(&or_empty(get("title")));
        JsString::join(&[file, symbol, JsString::default(), title.into()], "\0")
    } else {
        JsString::join(&[file, symbol, rule], "\0")
    };
    let mut h: u32 = 5381;
    for unit in basis.units() {
        h = h
            .wrapping_shl(5)
            .wrapping_add(h)
            .wrapping_add(u32::from(unit));
    }
    format!("{h:08x}")
}

/// `summarizeFindings`: the findings' total and their count by severity.
#[must_use]
pub fn summarize(findings: &[Js]) -> Js {
    let mut by = [0.0_f64; 5];
    for f in findings {
        let sev = f.as_obj().and_then(|o| o.get("severity"));
        if let Some(i) = sev
            .and_then(Js::as_str)
            .and_then(|s| SEVERITIES.iter().position(|k| *k == s))
            && let Some(n) = by.get_mut(i)
        {
            *n += 1.0;
        }
    }
    let mut counts = Obj::new();
    for (k, n) in SEVERITIES.iter().zip(by) {
        counts.set(*k, Js::Num(n));
    }
    Js::Obj(
        Obj::new()
            .with("total", Js::Num(by.iter().sum()))
            .with("bySeverity", Js::Obj(counts)),
    )
}

/// `recordFilename`: `<ts>-<kind>-<name>.json`, each part with what a file name cannot hold as `-`.
#[must_use]
pub fn filename(record: &Obj) -> String {
    let safe = |k: &str| -> String {
        let v = match record.get(k) {
            None | Some(Js::Null) => JsString::from("unknown"),
            Some(v) => v.to_js_text(),
        };
        char::decode_utf16(v.units())
            .map(|c| {
                let c = c.unwrap_or('-');
                if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                    c
                } else {
                    '-'
                }
            })
            .collect()
    };
    format!("{}-{}-{}.json", safe("ts"), safe("kind"), safe("name"))
}

fn title_units(s: &JsString) -> String {
    let lower = s.map_unicode(str::to_lowercase);
    // A surrogate, like every non-ASCII character, separates the ASCII words of a shingle.
    let text: String = lower
        .units()
        .map(|u| {
            char::from_u32(u32::from(u))
                .filter(char::is_ascii)
                .unwrap_or(' ')
        })
        .collect();
    title_shingle(&text)
}

fn unit_space(u: u16) -> bool {
    char::from_u32(u32::from(u)).is_some_and(|c| c.is_whitespace() || c == '\u{feff}')
}

fn unit_word(u: u16) -> bool {
    char::from_u32(u32::from(u)).is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn normalize_units(s: &JsString) -> JsString {
    if let Some(s) = s.as_str() {
        return normalize_symbol(s).into();
    }
    let lower: Vec<u16> = s.map_unicode(str::to_lowercase).units().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(&u) = lower.get(i) {
        let keyword = ["fn", "impl"].into_iter().find(|word| {
            (i == 0 || lower.get(i - 1).is_some_and(|u| !unit_word(*u)))
                && lower
                    .get(i..i + word.len())
                    .is_some_and(|slice| slice.iter().copied().eq(word.encode_utf16()))
                && lower.get(i + word.len()).is_some_and(|u| unit_space(*u))
        });
        if let Some(word) = keyword {
            i += word.len();
            while lower.get(i).is_some_and(|u| unit_space(*u)) {
                i += 1;
            }
        } else {
            out.push(u);
            i += 1;
        }
    }
    strip_generics(&mut out);
    let start = out
        .iter()
        .position(|u| !unit_space(*u))
        .unwrap_or(out.len());
    let end = out
        .iter()
        .rposition(|u| !unit_space(*u))
        .map_or(start, |i| i + 1);
    JsString::from_utf16(out.get(start..end).unwrap_or_default().to_vec())
}

fn strip_generics(out: &mut Vec<u16>) {
    loop {
        let mut open = None;
        let mut pair = None;
        for (i, &u) in out.iter().enumerate() {
            if u == u16::from(b'<') {
                open = Some(i);
            }
            if u == u16::from(b'>')
                && let Some(start) = open
            {
                pair = Some(start..=i);
                break;
            }
        }
        let Some(pair) = pair else { break };
        out.drain(pair);
    }
}

/// `indexProjection`: the record's line in `index.jsonl`; a field the record lacks and the line
/// carries as it stands is left out, as `JSON.stringify` leaves out `undefined`.
#[must_use]
pub fn index_projection(r: &Obj) -> Obj {
    let mut o = Obj::new();
    let as_is = |o: &mut Obj, k: &str| {
        if let Some(v) = r.get(k) {
            o.set(k, v.clone());
        }
    };
    let or_null = |o: &mut Obj, k: &str| o.set(k, r.get(k).cloned().unwrap_or(Js::Null));
    as_is(&mut o, "schemaVersion");
    or_null(&mut o, "runtime");
    for k in ["ts", "kind", "name"] {
        as_is(&mut o, k);
    }
    or_null(&mut o, "craftVersion");
    or_null(&mut o, "craftCommit");
    for k in ["project", "commit", "dirty"] {
        as_is(&mut o, k);
    }
    or_null(&mut o, "branch");
    or_null(&mut o, "head");
    let round = r.get("round").filter(|v| **v != Js::Null);
    o.set("round", round.cloned().unwrap_or(Js::Num(0.0)));
    as_is(&mut o, "verdict");
    let total = match r.get("findings") {
        Some(f) if f.truthy() => f.as_obj().and_then(|f| f.get("total")).cloned(),
        _ => Some(Js::Num(0.0)),
    };
    if let Some(t) = total {
        o.set("findingsTotal", t);
    }
    for k in ["nested", "via"] {
        as_is(&mut o, k);
    }
    or_null(&mut o, "outputTokens");
    if let Some(d) = r.get("driver").filter(|d| **d != Js::Null) {
        o.set("driver", d.clone());
    }
    o
}

#[cfg(test)]
mod tests;
