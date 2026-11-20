//! A double as JavaScript spells it (`Number.prototype.toString`, as `JSON.stringify` uses it): the
//! shortest digits that read back as the same double, laid out by the rules of ECMA-262's
//! `Number::toString` — plain up to 21 digits before the point and 6 zeros after it, else
//! `d.ddde±n`.

/// `String(n)`; `JSON.stringify` writes `null` where this says `NaN` or `Infinity`.
#[must_use]
pub fn number_text(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if n == 0.0 {
        return "0".into();
    }
    let sign = if n < 0.0 { "-" } else { "" };
    let (digits, point) = shortest(n.abs());
    format!("{sign}{}", laid_out(&digits, point))
}

/// The shortest round-trip digits of `n` (positive, finite) and `p`, where `n` is `0.digits × 10^p`.
fn shortest(n: f64) -> (String, i32) {
    // Rust's `{:e}` prints the shortest digits that read back as `n`, as `d.ddde<exp>`.
    let e = format!("{n:e}");
    let (mantissa, exp) = e.split_once('e').unwrap_or((&e, "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let exp: i32 = exp.parse().unwrap_or(0);
    (digits, exp + 1)
}

fn laid_out(digits: &str, point: i32) -> String {
    let k = i32::try_from(digits.len()).unwrap_or(i32::MAX);
    let zeros = |n: i32| "0".repeat(usize::try_from(n).unwrap_or(0));
    if k <= point && point <= 21 {
        return format!("{digits}{}", zeros(point - k));
    }
    if 0 < point && point <= 21 {
        let (int, frac) = digits.split_at(usize::try_from(point).unwrap_or(0));
        return format!("{int}.{frac}");
    }
    if -6 < point && point <= 0 {
        return format!("0.{}{digits}", zeros(-point));
    }
    let exp = point - 1;
    let sign = if exp < 0 { '-' } else { '+' };
    let (first, rest) = digits.split_at(1.min(digits.len()));
    let rest = if rest.is_empty() {
        String::new()
    } else {
        format!(".{rest}")
    };
    format!("{first}{rest}e{sign}{}", exp.abs())
}

/// The double as `serde_json` keeps a number: an integer when it is one within 2⁵³, else a float;
/// `null` for what JSON cannot hold.
pub(super) fn to_serde(n: f64) -> serde_json::Value {
    const SAFE: f64 = 9_007_199_254_740_992.0;
    if n.fract() == 0.0 && n.abs() < SAFE {
        #[expect(
            clippy::cast_possible_truncation,
            reason = "a whole number within 2^53 fits an i64 exactly"
        )]
        return serde_json::Value::from(n as i64);
    }
    serde_json::Number::from_f64(n).map_or(serde_json::Value::Null, serde_json::Value::Number)
}

#[cfg(test)]
mod tests {
    use super::number_text;

    #[test]
    fn numbers_are_spelled_as_javascript_spells_them() {
        for (n, want) in [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-3.0, "-3"),
            (0.1, "0.1"),
            (0.1 + 0.2, "0.30000000000000004"),
            (1.5, "1.5"),
            (123_456_789.0, "123456789"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (1.5e-7, "1.5e-7"),
            (0.000_001, "0.000001"),
            (2.5e25, "2.5e+25"),
            (f64::NAN, "NaN"),
        ] {
            assert_eq!(number_text(n), want, "{n}");
        }
    }
}
