use super::super::{
    manifest::{lines::Document, patterns},
    pattern::Engine,
};
use craft_store::js::{self, Js, JsString};

#[test]
fn ecmascript_regressions_from_the_two_independent_corpora() {
    let engine = Engine::new().unwrap();
    let cases = [
        (r"\u{2}(v1)", "uuv1", Some("v1")),
        (r"\u{61}(v1)", "av1", None),
        ("(?<𝒜>v1)", "v1", Some("v1")),
        (r"(?<\u{1D49C}>v1)", "v1", Some("v1")),
        (r"(?<\uD835\uDC9C>v1)", "v1", Some("v1")),
        ("(?<𝒜>v1)\\k<𝒜>", "v1v1", Some("v1")),
        (r"(?<=([ab]+))c", "ababc", Some("abab")),
        (r"(?<=(a|ab))c", "abc", Some("ab")),
        (r"(?<=\1(a+))b", "aab", Some("a")),
        (r"(?<=(a+)\1)b", "aab", Some("aa")),
        (r"(?=(a+))a*b\1", "aaabaaa", Some("aaa")),
        (r"(?:(a)|b)+", "ab", None),
        (r"(?:(a)?b)+", "abb", None),
        (r"(?<!(a))b", "b", None),
        (r"(?=(a))?a", "a", None),
        (r"(?=(a))*a", "a", None),
        (r"(?=(a))+a", "a", Some("a")),
        (r"\1(a)", "a", Some("a")),
        (r"(a)\11", "a\t", Some("a")),
        (r"[\c_](a)", "\u{001f}a", Some("a")),
        (r"[\s-a](a)", "-a", Some("a")),
        (r"[a-\d](a)", "3a", Some("a")),
        (r"\x(a)", "xa", Some("a")),
        (r"\k<x>(a)", "k<x>a", Some("a")),
        (r"\p{ASCII}(a)", "p{ASCII}a", Some("a")),
        (r"^..(v1)$", "😀v1", Some("v1")),
        (r"^.(v1)$", "😀v1", None),
        (r"^(v1)$", "\u{2028}v1", Some("v1")),
        (r"^\s(v1)$", "\u{feff}v1", Some("v1")),
        (r"^\s(v1)$", "\u{0085}v1", None),
        (r"^\w(v1)$", "év1", None),
        (r"^\d(v1)$", "١v1", None),
        (r"(v1)?v2", "v2", None),
    ];
    for (source, text, expected) in cases {
        engine.check(&source.into()).unwrap();
        let found = engine.exec(&source.into(), "m", &text.into()).unwrap();
        let capture = found.as_ref().and_then(|m| m.get(1)).and_then(Js::as_str);
        assert_eq!(capture, expected, "{source:?} / {text:?}");
    }
}

#[test]
fn bounds_groups_first_match_and_surrogate_transport() {
    let engine = Engine::new().unwrap();
    for source in ["v1", "(v)(1)", "(?<a>x)(y)", "(v1", "(?<x>v1)|(?<x>v2)"] {
        assert!(engine.check(&source.into()).is_err(), "{source}");
    }
    engine
        .check(&format!("(v){}", "x".repeat(197)).into())
        .unwrap();
    assert_eq!(
        engine
            .check(&format!("(v){}", "x".repeat(198)).into())
            .unwrap_err()
            .to_string(),
        "versionMatch over 200 characters"
    );
    engine
        .check(&format!("(v){}", "😀".repeat(98)).into())
        .unwrap();
    assert!(
        engine
            .check(&format!("(v){}", "😀".repeat(99)).into())
            .is_err()
    );
    assert_eq!(
        engine
            .read_ref(&"(v[0-9])".into(), &"v1 v2".into())
            .unwrap(),
        "v1"
    );
    let surrogate = js::parse(r#""\ud800""#).unwrap().to_js_text();
    let capture = engine
        .exec(&"(.)".into(), "m", &surrogate)
        .unwrap()
        .unwrap();
    assert_eq!(capture.get(1), Some(&Js::str(&surrogate)));
    let pattern = JsString::join(&[surrogate.clone(), "(v1)".into()], "");
    engine.check(&pattern).unwrap();
    assert_eq!(
        engine
            .read_ref(&pattern, &JsString::join(&[surrogate, "v1".into()], ""))
            .unwrap(),
        "v1"
    );
    for n in [
        "2147483648",
        "4294967296",
        "9007199254740992",
        "9999999999999999999999999999999999999999999999999",
    ] {
        assert_eq!(
            engine
                .read_ref(&format!("^a{{0,{n}}}(v1)$").into(), &"av1".into())
                .unwrap(),
            "v1"
        );
    }
}

#[test]
fn pair_patterns_allow_mapping_growth_but_not_deeper_tags_or_another_mapping() {
    let engine = Engine::new().unwrap();
    let before = "image:\n  repository: ghcr.io/a/app\n  tag: v1.2\nother:\n  tag: v9\n";
    let doc = Document::new(&engine, before).unwrap();
    let source = patterns::pair(&doc, 1, 2, "tag").into();
    let grown = "image:\n  repository: ghcr.io/a/app\n  pullPolicy: IfNotPresent\n  # pinned\n\n  extra:\n    tag: deeper\n  tag: v1.3\nother:\n  tag: v9\n";
    assert_eq!(engine.read_ref(&source, &grown.into()).unwrap(), "v1.3");
    assert_eq!(
        engine
            .read_ref(
                &source,
                &"image:\n  repository: ghcr.io/a/app\nother:\n  tag: v9\n".into()
            )
            .unwrap_err()
            .to_string(),
        "versionMatch found no version in versionFrom"
    );
    let before = "a:\n  tag: v3\n  repository: x/w\n";
    let doc = Document::new(&engine, before).unwrap();
    let source = patterns::pair(&doc, 2, 1, "tag").into();
    assert_eq!(
        engine
            .read_ref(
                &source,
                &"a:\n  tag: v3\n  pullPolicy: Always\n  repository: x/w\n".into()
            )
            .unwrap(),
        "v3"
    );
    let before = format!(
        "image:\n  repository: ghcr.io/{}\n  tag: v1\n",
        "r".repeat(80)
    );
    let doc = Document::new(&engine, &before).unwrap();
    let source = patterns::pair(&doc, 1, 2, "tag");
    assert!(!source.contains("{0,"));
    engine.check(&source.as_str().into()).unwrap();
    assert_eq!(
        engine.read_ref(&source.into(), &before.into()).unwrap(),
        "v1"
    );
}
