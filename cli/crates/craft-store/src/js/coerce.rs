//! JavaScript's readings of a value beside `String()` ([`Js::to_js_text`]): `Number()`, and the
//! whitespace `String.prototype.trim` and a regular expression's `\s` know — Unicode `White_Space`
//! without U+0085, which JavaScript does not count, and with U+FEFF, which it does.

use super::{Js, JsString};

/// The members of [`is_space`] spelled for the inside of a `regex` character class.
pub const SPACE_CLASS: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

/// Whether `c` is whitespace to JavaScript's `trim` and `\s`.
#[must_use]
pub fn is_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// `s.trim()`.
#[must_use]
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_space)
}

/// Whether the code unit `u` is whitespace to JavaScript (a surrogate never is).
#[must_use]
pub fn is_space_unit(u: u16) -> bool {
    char::from_u32(u32::from(u)).is_some_and(is_space)
}

/// `s.trim()` over its code units, an unpaired surrogate kept.
#[must_use]
pub fn trim_text(s: &JsString) -> JsString {
    let units: Vec<u16> = s.units().collect();
    let start = units
        .iter()
        .position(|u| !is_space_unit(*u))
        .unwrap_or(units.len());
    let end = units
        .iter()
        .rposition(|u| !is_space_unit(*u))
        .map_or(start, |i| i + 1);
    JsString::from_utf16(units.get(start..end).unwrap_or_default().to_vec())
}

/// An unsigned `0x`, `0o` or `0b` literal's value, when `s` is one; NaN for one with no digits
/// or a digit outside its base.
fn radix_literal(s: &str) -> Option<f64> {
    let (base, digits) = [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ]
    .into_iter()
    .find_map(|(p, base)| s.strip_prefix(p).map(|d| (base, d)))?;
    if digits.is_empty() || !digits.chars().all(|c| c.is_digit(base)) {
        return Some(f64::NAN);
    }
    Some(exact_value(digits, base))
}

/// The digits' value rounded once to the nearest double, as JavaScript rounds a literal's
/// mathematical value: exact in an integer while it fits 128 bits, past that (a literal of more
/// than 32 hex digits, whose rounding no case needs) digit by digit.
#[expect(
    clippy::cast_precision_loss,
    reason = "the one rounding to a double is the conversion JavaScript makes"
)]
fn exact_value(digits: &str, base: u32) -> f64 {
    let exact = digits.chars().try_fold(0u128, |n, c| {
        n.checked_mul(u128::from(base))?
            .checked_add(u128::from(c.to_digit(base)?))
    });
    exact.map_or_else(
        || {
            digits
                .chars()
                .filter_map(|c| c.to_digit(base))
                .fold(0.0, |n, d| n * f64::from(base) + f64::from(d))
        },
        |n| n as f64,
    )
}

/// `Number(s)` of a string: trimmed, '' is 0, a radix literal, `Infinity` with its sign, a decimal
/// literal; anything else NaN.
#[must_use]
pub fn number_of_text(s: &str) -> f64 {
    let s = trim(s);
    if s.is_empty() {
        return 0.0;
    }
    if let Some(n) = radix_literal(s) {
        return n;
    }
    let unsigned = s.strip_prefix(['+', '-']).unwrap_or(s);
    if unsigned == "Infinity" {
        return if s.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    // Rust's float reader also takes `inf` and `NaN`; JavaScript's decimal literal has no letter but the exponent's.
    if unsigned.is_empty()
        || !unsigned
            .chars()
            .all(|c| c.is_ascii_digit() || ".eE+-".contains(c))
    {
        return f64::NAN;
    }
    s.parse().unwrap_or(f64::NAN)
}

impl Js {
    /// `Number(v)`: null 0, a boolean 0 or 1, a string as [`number_of_text`] reads it, an array
    /// the number of its `String()`, an object NaN.
    #[must_use]
    pub fn to_js_number(&self) -> f64 {
        match self {
            Self::Null => 0.0,
            Self::Bool(b) => f64::from(u8::from(*b)),
            Self::Num(n) => *n,
            Self::Str(s) => s.as_str().map_or(f64::NAN, number_of_text),
            Self::Arr(_) => self.to_js_text().as_str().map_or(f64::NAN, number_of_text),
            Self::Obj(_) => f64::NAN,
        }
    }
}

#[cfg(test)]
mod tests;
