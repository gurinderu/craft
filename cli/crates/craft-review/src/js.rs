//! A model field or record value (`serde_json::Value`) read as JavaScript reads it — `String(v ??
//! '')`, `String(v ?? '').trim()`, `Number(v)`, `findingLine`, `.length` and `.slice` in UTF-16
//! code units, `Math.max` — through the store's JavaScript model (`craft_store::js`), for the rules
//! ported from the engines: the PR-thread reader (`rejections`), the doubtful-finding poster
//! (`publish/doubtful`), the finding sort (`publish/sort`), the memory's records, matcher, judge
//! and rules (`memory`), and the prompt fields (`prompts`); held to them by
//! `content/parity/pr-rejections-cases.json`, `finding-post-cases.json` and `memory-cases.json`.

use craft_store::js::{Js, JsStr, JsString};
use serde_json::Value;

// JavaScript's whitespace, `trim`, `String()`, `Number()` and a number's text are the store's
// (`craft_store::js`), one copy for every crate.
pub(crate) use craft_store::js::{is_space, number_text};

/// `s.length`: its UTF-16 code units.
pub(crate) fn len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// The first `n` UTF-16 code units of `s`, as `s.slice(0, n)` keeps them.
pub(crate) fn head(s: &str, n: usize) -> String {
    JsString::from_utf16(s.encode_utf16().take(n).collect()).to_utf8_lossy()
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
    text(v).js_trim().to_owned()
}

/// `Number(v ?? fallback)` ([`Js::to_js_number`]), `fallback` standing for an absent value.
pub(crate) fn number(v: Option<&Value>, fallback: f64) -> f64 {
    v.map_or(fallback, |v| Js::from(v).to_js_number())
}

/// `findingLine`: `Number(v)` when it is a positive integer, else 0.
pub(crate) fn finding_line(v: Option<&Value>) -> u64 {
    let n = number(v, f64::NAN);
    if n.is_finite() && n >= 1.0 && n.trunc().to_bits() == n.to_bits() {
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a positive whole double, saturating past u64 as a line never is"
        )]
        let line = n as u64;
        line
    } else {
        0
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::finding_line;

    /// `findingLine` in `integrations/shared/prior-decision-match.mjs` gives these (computed with
    /// Node): `Number(line)` when a positive integer, else 0.
    #[test]
    fn a_findings_line_is_read_as_finding_line_reads_it() {
        for (line, want) in [
            (json!("5.0"), 5),
            (json!(5.0), 5),
            (json!("0x10"), 16),
            (json!(true), 1),
            (json!(" 7 "), 7),
            (json!("\u{feff}7"), 7),
            (json!("\u{85}7"), 0),
            (json!("1e2"), 100),
            (json!([4]), 4),
            (json!(1.5), 0),
            (json!(-3), 0),
            (json!(null), 0),
            (json!(""), 0),
        ] {
            assert_eq!(finding_line(Some(&line)), want, "{line}");
        }
        assert_eq!(finding_line(None), 0);
    }
}
