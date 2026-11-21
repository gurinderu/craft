//! Lossless matching keys; only the ASCII-word projection discards non-word code units (#205).

use craft_store::js::{JsString, Obj};

pub(super) fn text(o: &Obj, key: &str) -> JsString {
    let units: Vec<_> = o.text_units(key).units().collect();
    let start = units
        .iter()
        .position(|u| !js_space(*u))
        .unwrap_or(units.len());
    let end = units
        .iter()
        .rposition(|u| !js_space(*u))
        .map_or(0, |i| i + 1);
    JsString::from_utf16(units.get(start..end).unwrap_or_default().to_vec())
}

// ECMAScript WhiteSpace + LineTerminator, not Rust's Unicode White_Space (U+0085).
fn js_space(u: u16) -> bool {
    matches!(u, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

pub(super) fn parts(s: &JsString) -> Vec<JsString> {
    if let Some(s) = s.as_str() {
        return crate::memory::scope_parts(s)
            .into_iter()
            .map(JsString::from)
            .collect();
    }
    let units: Vec<_> = s.units().collect();
    units
        .split(|u| matches!(*u, 47 | 92))
        .filter(|s| !s.is_empty() && *s != [46])
        .map(|s| JsString::from_utf16(s.to_vec()))
        .collect()
}

pub(super) fn within(file: &JsString, scope: &JsString) -> bool {
    let file = parts(file);
    !file.is_empty() && file.starts_with(&parts(scope))
}

pub(super) fn touched(file: &JsString, paths: &[String]) -> bool {
    paths.is_empty()
        || paths
            .iter()
            .any(|p| parts(file).starts_with(&parts(&p.into())))
}

pub(super) fn overlap(a: &JsString, b: &JsString) -> f64 {
    // Unpaired units delimit words just like every other non-ASCII word character. This view is
    // never used as an identity or emitted; the original title remains a JsString.
    let words_view = |s: &JsString| {
        char::decode_utf16(s.units())
            .map(|c| c.unwrap_or('\0'))
            .collect::<String>()
    };
    crate::ledger::overlap(&words_view(a), &words_view(b))
}
