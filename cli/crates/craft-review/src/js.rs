//! Values read as JavaScript reads them, for the rules the JavaScript PR-thread reader and
//! doubtful-finding poster held
//! (`content/parity/pr-rejections-cases.json`, `finding-post-cases.json`): `String(v ?? '')`, `.trim()`, `Number(v)`
//! (a `0x`, `0o` or `0b` string read in its base, as the JavaScript's `Number()` reads it),
//! `.length` in UTF-16 code units.

use serde_json::Value;

// JavaScript's whitespace, `trim`, `Number()` of a string and a number's text are the store's
// (`craft_store::js`), one copy for every crate.
pub(crate) use craft_store::js::{is_space as space, number_of_text, number_text, trim};

/// `s.length`: its UTF-16 code units.
pub(crate) fn len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// The first `n` UTF-16 code units of `s`, as `s.slice(0, n)` keeps them.
pub(crate) fn head(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

/// `String(v ?? '')`.
pub(crate) fn text(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.as_f64().map_or_else(|| n.to_string(), number_text),
        Some(Value::Array(a)) => a
            .iter()
            .map(|x| text(Some(x)))
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// `String(v ?? '').trim()`.
pub(crate) fn str_of(v: Option<&Value>) -> String {
    trim(&text(v)).to_owned()
}

/// `Number(v ?? fallback)`, `fallback` standing for an absent value.
pub(crate) fn number(v: Option<&Value>, fallback: f64) -> f64 {
    match v {
        None => fallback,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => number_of_text(s),
        Some(Value::Array(a)) if a.len() <= 1 => {
            a.first().map_or(0.0, |x| number_of_text(&text(Some(x))))
        }
        Some(_) => f64::NAN,
    }
}

/// `Math.max(a, b)`: NaN when either is.
pub(crate) fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}
