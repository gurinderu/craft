use super::*;

fn j(s: &str) -> Json {
    serde_json::from_str(s).unwrap()
}

#[test]
fn string_writes_what_javascript_writes() {
    let s = |t: &str| string(Some(&j(t)));
    assert_eq!(string(None), "undefined");
    assert_eq!(s("null"), "null");
    assert_eq!(s("7"), "7");
    assert_eq!(s("1.0"), "1");
    assert_eq!(s("2.5"), "2.5");
    assert_eq!(s("true"), "true");
    assert_eq!(s(r#""t""#), "t");
    assert_eq!(s(r#"[1,null,"a"]"#), "1,,a");
    assert_eq!(s("{}"), "[object Object]");
}

#[test]
fn number_reads_what_javascript_reads() {
    let n = |t: &str| number(Some(&j(t)));
    assert!(number(None).is_nan());
    assert!((n("null") - 0.0).abs() < f64::EPSILON);
    assert!((n("true") - 1.0).abs() < f64::EPSILON);
    assert!((n(r#"" 6 ""#) - 6.0).abs() < f64::EPSILON);
    assert!((n(r#""""#) - 0.0).abs() < f64::EPSILON);
    assert!((n(r#""0x1""#) - 1.0).abs() < f64::EPSILON);
    assert!((n(r#""0b11""#) - 3.0).abs() < f64::EPSILON);
    assert!((n("[2]") - 2.0).abs() < f64::EPSILON);
    assert!((n("[]") - 0.0).abs() < f64::EPSILON);
    assert!(n(r#""-Infinity""#).is_infinite());
    assert!(n(r#""inf""#).is_nan());
    assert!(n(r#""1x""#).is_nan());
    assert!(n("{}").is_nan());
}

#[test]
fn truthiness_and_trim_are_javascripts() {
    assert!(!truthy(None));
    assert!(!truthy(Some(&j("0"))));
    assert!(!truthy(Some(&j(r#""""#))));
    assert!(truthy(Some(&j("[]"))));
    assert_eq!(trim("\u{feff} a \n"), "a");
}
