use super::*;
use crate::js::parse;

fn obj(text: &str) -> Obj {
    parse(text).unwrap().as_obj().unwrap().clone()
}

#[test]
fn fingerprints_are_the_javascript_ones() {
    for (f, want) in [
        (
            r#"{"file":"a.rs","ruleId":"R1","symbol":"Fn Foo<Vec<Map<K,V>>>"}"#,
            "247135e0",
        ),
        (
            r#"{"file":"a.rs","title":"Unwrap on  None!! panics"}"#,
            "60258981",
        ),
        ("{}", "0b86b2e5"),
        (
            r#"{"file":"src/é.rs","line":3,"title":"ünïcode 😀 title"}"#,
            "de5b0243",
        ),
        (
            r#"{"file":"x","symbol":"impl  Bar","ruleId":"","title":"b a"}"#,
            "c09422d5",
        ),
    ] {
        assert_eq!(fingerprint(Some(&obj(f))), want, "{f}");
    }
}

#[test]
fn findings_are_counted_by_severity() {
    let f = parse(r#"[{"severity":"High"},{"severity":"Low"},{"severity":"x"},{}]"#).unwrap();
    assert_eq!(
        summarize(f.as_arr().unwrap()).compact(),
        r#"{"total":2,"bySeverity":{"Critical":0,"High":1,"Medium":0,"Low":1,"Info":0}}"#
    );
}

#[test]
fn the_index_line_leaves_out_what_the_record_lacks() {
    let r = obj(
        r#"{"schemaVersion":1,"ts":"t","kind":"workflow","name":"review","project":"/p","dirty":false,"round":null,"findings":{"total":2},"nested":false,"via":null,"driver":"cli"}"#,
    );
    assert_eq!(
        Js::Obj(index_projection(&r)).compact(),
        r#"{"schemaVersion":1,"runtime":null,"ts":"t","kind":"workflow","name":"review","craftVersion":null,"craftCommit":null,"project":"/p","dirty":false,"branch":null,"head":null,"round":0,"findingsTotal":2,"nested":false,"via":null,"outputTokens":null,"driver":"cli"}"#
    );
}

#[test]
fn a_file_name_holds_only_what_a_name_can() {
    let r = obj(r#"{"ts":"2026-01-01T00-00-00Z","kind":"work flow","name":"a/b"}"#);
    assert_eq!(filename(&r), "2026-01-01T00-00-00Z-work-flow-a-b.json");
    assert_eq!(filename(&Obj::new()), "unknown-unknown-unknown.json");
}

#[test]
fn a_symbol_normalizes_alike_by_either_path_with_next_line_no_space() {
    // U+0085 is no JavaScript whitespace: `fn\u{85}x` keeps its keyword, and is not trimmed.
    for symbol in ["fn\u{85}x", "\u{85}Foo\u{85}", "impl\u{2028}Bar<T>"] {
        let units = JsString::from_utf16(symbol.encode_utf16().chain([0xd800]).collect());
        let mut want: Vec<u16> = normalize_symbol(symbol).encode_utf16().collect();
        let via_units: Vec<u16> = normalize_units(&units).units().collect();
        want.push(0xd800);
        assert_eq!(via_units, want, "{symbol:?}");
    }
    assert_eq!(normalize_symbol("fn\u{85}x"), "fn\u{85}x");
    assert_eq!(normalize_symbol("\u{85}Foo\u{85}"), "\u{85}foo\u{85}");
    assert_eq!(normalize_symbol("impl\u{2028}Bar<T>"), "bar");
}

#[test]
fn the_unpaired_surrogate_path_trims_javascript_whitespace_around_the_symbol() {
    let units: Vec<u16> = " \u{2028}\u{feff}Foo"
        .encode_utf16()
        .chain([0xd800])
        .chain("\u{a0} \t".encode_utf16())
        .collect();
    let got: Vec<u16> = normalize_units(&JsString::from_utf16(units))
        .units()
        .collect();
    let want: Vec<u16> = "foo".encode_utf16().chain([0xd800]).collect();
    assert_eq!(got, want);
}
