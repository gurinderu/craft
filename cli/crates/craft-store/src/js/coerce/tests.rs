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
        // 2^53 + 1 rounds once, to 2^53, as JavaScript's literal does — not digit by digit.
        (r#""0x20000000000001""#, 9_007_199_254_740_992.0),
        (r#""0x1fffffffffffff1""#, 2f64.powi(57) - 16.0),
        // Exact, then rounded once (JavaScript: 144115188075855904); a fold digit by digit gives
        // 144115188075855872.
        (r#""0x200000000000011""#, 2f64.powi(57) + 32.0),
        // Past 128 bits the digits fold: 2^160 − 1 rounds to 2^160.
        (
            r#""0xffffffffffffffffffffffffffffffffffffffff""#,
            2f64.powi(160),
        ),
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

#[test]
fn truthiness_is_javascripts() {
    for (text, want) in [
        ("0", false),
        ("-0", false),
        (r#""""#, false),
        ("null", false),
        ("false", false),
        ("[]", true),
        ("{}", true),
        (r#""0""#, true),
        ("1", true),
    ] {
        assert_eq!(parse(text).unwrap().truthy(), want, "{text}");
    }
}

#[test]
fn the_regex_class_holds_exactly_the_characters_is_space_does() {
    let class = regex::Regex::new(&format!("^[{SPACE_CLASS}]$")).unwrap();
    let mut buf = [0u8; 4];
    for c in (0..=0x10_ffff).filter_map(char::from_u32) {
        assert_eq!(
            class.is_match(c.encode_utf8(&mut buf)),
            is_space(c),
            "{:#x}",
            u32::from(c)
        );
    }
}

#[test]
fn trim_over_code_units_keeps_an_unpaired_surrogate() {
    let s = JsString::from_utf16(vec![0x20, 0xd800, 0x61, 0xfeff, 0x85]);
    assert_eq!(
        trim_text(&s),
        JsString::from_utf16(vec![0xd800, 0x61, 0xfeff, 0x85])
    );
    assert_eq!(trim_text(&JsString::from(" \u{a0}")), "");
    assert_eq!(s.to_utf8_lossy(), " \u{fffd}a\u{feff}\u{85}");
}

#[test]
fn the_text_methods_are_javascripts() {
    let s = "\u{feff} a\u{85} b \u{2028}";
    assert_eq!(s.js_trim(), "a\u{85} b");
    assert_eq!(s.js_trim_start(), "a\u{85} b \u{2028}");
    assert_eq!(s.js_trim_end(), "\u{feff} a\u{85} b");
    assert_eq!(
        s.js_split_whitespace().collect::<Vec<_>>(),
        ["a\u{85}", "b"]
    );
}
