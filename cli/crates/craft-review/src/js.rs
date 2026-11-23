//! Values read as JavaScript reads them, for the rules the JavaScript PR-thread reader and
//! doubtful-finding poster held
//! (`content/parity/pr-rejections-cases.json`, `finding-post-cases.json`): `String(v ?? '')`, `.trim()`, `Number(v)`
//! (a `0x`, `0o` or `0b` string read in its base, as the JavaScript's `Number()` reads it),
//! `.length` in UTF-16 code units.

use craft_store::js::Js;
use serde_json::Value;

// JavaScript's whitespace, `trim`, `String()`, `Number()` and a number's text are the store's
// (`craft_store::js`), one copy for every crate.
pub(crate) use craft_store::js::{is_space, number_text, trim};

/// `s.length`: its UTF-16 code units.
pub(crate) fn len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// The first `n` UTF-16 code units of `s`, as `s.slice(0, n)` keeps them.
pub(crate) fn head(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

/// `String(v ?? '')` ([`Js::to_js_text`]).
pub(crate) fn text(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(v) => Js::from(v).to_js_text().to_utf8_lossy(),
    }
}

/// `String(v ?? '').trim()`.
pub(crate) fn str_of(v: Option<&Value>) -> String {
    trim(&text(v)).to_owned()
}

/// `Number(v ?? fallback)` ([`Js::to_js_number`]), `fallback` standing for an absent value.
pub(crate) fn number(v: Option<&Value>, fallback: f64) -> f64 {
    v.map_or(fallback, |v| Js::from(v).to_js_number())
}

/// `Math.max(a, b)`: NaN when either is.
pub(crate) fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}
