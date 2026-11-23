use super::*;
use crate::js::parse;

fn number(text: &str) -> f64 {
    parse(text).unwrap().to_js_number()
}

fn same(a: f64, b: f64) -> bool {
    (a.is_nan() && b.is_nan()) || a.to_bits() == b.to_bits()
}

#[test]
fn number_reads_what_javascript_reads() {
    for (text, want) in [
        ("null", 0.0),
        ("true", 1.0),
        ("false", 0.0),
        ("6", 6.0),
        (r#"" 6 ""#, 6.0),
        (r#""﻿7 ""#, 7.0),
        (r#""""#, 0.0),
        (r#""0x1f""#, 31.0),
        (r#""0b11""#, 3.0),
        (r#""0o7""#, 7.0),
        (r#""1e2""#, 100.0),
        (r#""-.5""#, -0.5),
        (r#""-Infinity""#, f64::NEG_INFINITY),
        ("[5]", 5.0),
        ("[]", 0.0),
        (r#""0x""#, f64::NAN),
        (r#""-0x1""#, f64::NAN),
        (r#""inf""#, f64::NAN),
        (r#""NaN""#, f64::NAN),
        (r#""1x""#, f64::NAN),
        ("[1,2]", f64::NAN),
        ("{}", f64::NAN),
        (r#""\u00851""#, f64::NAN),
    ] {
        assert!(same(number(text), want), "{text}: {}", number(text));
    }
}

#[test]
fn whitespace_is_javascripts_without_next_line_and_with_the_byte_order_mark() {
    assert!(is_space('\u{feff}') && is_space('\u{2028}') && is_space('\u{a0}') && is_space('\t'));
    assert!(!is_space('\u{85}'));
    assert_eq!(trim("\u{feff} a \n"), "a");
    assert_eq!(trim("\u{85}a"), "\u{85}a");
}
