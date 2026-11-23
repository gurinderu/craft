//! JavaScript's own readings of a value, as the engine applies them to what an agent or a caller
//! passed: `String()`, `Number()`, truthiness, `String.prototype.trim` and `\s`.

use crate::json::Json;

/// Whether `c` is whitespace to JavaScript's `\s` and `trim`: Unicode `White_Space` and U+FEFF.
#[must_use]
pub fn is_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// `s.trim()`.
#[must_use]
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_space)
}

/// A number as `String()` writes it: an integral finite one without a fraction, else as Rust
/// writes the float (which agrees with JavaScript short of exponent forms).
fn number_text(n: &serde_json::Number) -> String {
    match n.as_f64() {
        Some(f)
            if n.is_f64() && f.is_finite() && f.fract().abs() < f64::EPSILON && f.abs() < 1e21 =>
        {
            format!("{f:.0}")
        }
        _ => n.to_string(),
    }
}

/// `String(v)`; `None` (an absent field) is `undefined`. An array joins its elements with
/// commas, null and absent ones empty; an object is `[object Object]`.
#[must_use]
pub fn string(v: Option<&Json>) -> String {
    match v {
        None => "undefined".into(),
        Some(Json::Null) => "null".into(),
        Some(Json::Bool(b)) => b.to_string(),
        Some(Json::Number(n)) => number_text(n),
        Some(Json::String(s)) => s.clone(),
        Some(Json::Array(a)) => a
            .iter()
            .map(|x| {
                if matches!(x, Json::Null) {
                    String::new()
                } else {
                    string(Some(x))
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Json::Object(_)) => "[object Object]".into(),
    }
}

/// Whether `v` is truthy; `None` (absent) is not.
#[must_use]
pub fn truthy(v: Option<&Json>) -> bool {
    match v {
        None | Some(Json::Null) => false,
        Some(Json::Bool(b)) => *b,
        Some(Json::Number(n)) => n.as_f64().is_some_and(|f| f.abs() > 0.0),
        Some(Json::String(s)) => !s.is_empty(),
        Some(Json::Array(_) | Json::Object(_)) => true,
    }
}

#[expect(
    clippy::cast_precision_loss,
    reason = "`Number()` of a long hex literal rounds the same way"
)]
/// `Number(s)` of a string: trimmed, '' is 0, `0x`/`0o`/`0b` integers, `Infinity`, a decimal
/// literal; anything else NaN.
fn number_of_text(s: &str) -> f64 {
    let s = trim(s);
    let radix = |p: &str, r: u32| {
        s.strip_prefix(p)
            .map(|d| u64::from_str_radix(d, r).map_or(f64::NAN, |n| n as f64))
    };
    if s.is_empty() {
        return 0.0;
    }
    if let Some(n) = radix("0x", 16)
        .or_else(|| radix("0X", 16))
        .or_else(|| radix("0o", 8))
        .or_else(|| radix("0b", 2))
    {
        return n;
    }
    match s.trim_start_matches(['+', '-']) {
        "Infinity" => {
            return if s.starts_with('-') {
                f64::NEG_INFINITY
            } else {
                f64::INFINITY
            };
        }
        rest if rest.is_empty()
            || !rest
                .chars()
                .all(|c| c.is_ascii_digit() || ".eE+-".contains(c)) =>
        {
            return f64::NAN;
        }
        _ => {}
    }
    s.parse().unwrap_or(f64::NAN)
}

/// `Number(v)`; `None` (absent) and an object are NaN, an array is the number of its `String()`.
#[must_use]
pub fn number(v: Option<&Json>) -> f64 {
    match v {
        None | Some(Json::Object(_)) => f64::NAN,
        Some(Json::Null) => 0.0,
        Some(Json::Bool(b)) => f64::from(u8::from(*b)),
        Some(Json::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Json::String(s)) => number_of_text(s),
        Some(a @ Json::Array(_)) => number_of_text(&string(Some(a))),
    }
}

#[cfg(test)]
mod tests;
