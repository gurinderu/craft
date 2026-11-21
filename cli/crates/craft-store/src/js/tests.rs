use super::*;

#[test]
fn keys_keep_javascripts_order_index_keys_first_ascending() {
    let v = parse(r#"{"b":1,"10":2,"a":3,"2":4,"b":5,"01":6}"#).unwrap();
    assert_eq!(v.compact(), r#"{"2":4,"10":2,"b":5,"a":3,"01":6}"#);
}

#[test]
fn pretty_text_is_json_stringify_with_an_indent_of_two() {
    let v = parse(r#"{"a":[],"b":{},"c":[1,{"d":"x\ny\u0001"}],"e":null}"#).unwrap();
    assert_eq!(
        v.pretty(),
        "{\n  \"a\": [],\n  \"b\": {},\n  \"c\": [\n    1,\n    {\n      \"d\": \"x\\ny\\u0001\"\n    }\n  ],\n  \"e\": null\n}"
    );
}

#[test]
fn a_text_round_trips_through_the_reader_and_the_writer() {
    let text = r#"{"s":"é\"\\/ 😀","n":-1.5e-7,"t":true,"z":[0.1,1e21]}"#;
    assert_eq!(
        parse(text).unwrap().compact(),
        "{\"s\":\"é\\\"\\\\/\u{2028}😀\",\"n\":-1.5e-7,\"t\":true,\"z\":[0.1,1e+21]}"
    );
}

#[test]
fn what_is_not_json_is_refused() {
    for bad in ["", "{", "[1,]", "{\"a\" 1}", "01", "1 2", "\"\t\"", "nul"] {
        assert!(parse(bad).is_err(), "{bad:?}");
    }
}

#[test]
fn string_of_a_value_is_javascripts() {
    let v = parse(r#"[null,true,3,"s",[1,null,[2]],{}]"#).unwrap();
    let got: Vec<String> = v
        .as_arr()
        .unwrap()
        .iter()
        .map(Js::to_js_string)
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(got, ["null", "true", "3", "s", "1,,2", "[object Object]"]);
}
#[test]
fn utf16_values_survive_parse_clone_and_both_writers() {
    for (input, expected) in [
        (r#""\ud800""#, r#""\ud800""#),
        (r#""\udc00""#, r#""\udc00""#),
        (
            r#""\ud800\ud801x\udc00\udc01""#,
            r#""\ud800\ud801x\udc00\udc01""#,
        ),
        (r#""\ud83d\ude00""#, "\"😀\""),
        (r#""\ud800\ud800\udc00""#, "\"\\ud800𐀀\""),
        (r#""\udbff\udfff""#, "\"\u{10ffff}\""),
        (r#""\udc00\ud800""#, r#""\udc00\ud800""#),
        (r#""\\ud800""#, r#""\\ud800""#),
        ("\"�é😀\"", "\"�é😀\""),
    ] {
        let parsed = parse(input).unwrap();
        let cloned = parsed.clone();
        assert_eq!(cloned.compact(), expected, "{input}");
        assert_eq!(cloned.pretty(), expected, "{input}");
        assert_eq!(parse(expected).unwrap(), parsed);
    }
}

#[test]
fn utf16_key_identity_and_nested_spreads_match_javascript() {
    let source = parse(r#"{"\ud800":1,"\ud801":2,"�":3,"\\ud800":4,"😀":5,"\ud83d\ude00":6,"10":7,"2":8,"\ud800":9,"nested":{"\udc00":["\ud800",{"\ud801":"\udc01"}]}}"#).unwrap();
    let mut spread = Obj::new();
    spread.spread(source.as_obj().unwrap());
    spread.spread(&source.as_obj().unwrap().clone());
    let value = Js::Obj(spread);
    let expected = r#"{"2":8,"10":7,"\ud800":9,"\ud801":2,"�":3,"\\ud800":4,"😀":6,"nested":{"\udc00":["\ud800",{"\ud801":"\udc01"}]}}"#;
    assert_eq!(value.compact(), expected);
    assert_eq!(parse(&value.pretty()).unwrap(), value);
    assert_eq!(value.as_obj().unwrap().len(), 8);
}

#[test]
fn utf16_pretty_bytes_are_javascript_stringify_bytes() {
    let v = parse(r#"{"\ud800":1,"\udc00":"\ud801","pair":"\ud83d\ude00","literal":"\\ud800"}"#)
        .unwrap();
    assert_eq!(
        v.pretty(),
        "{\n  \"\\ud800\": 1,\n  \"\\udc00\": \"\\ud801\",\n  \"pair\": \"😀\",\n  \"literal\": \"\\\\ud800\"\n}"
    );
}

#[test]
fn utf16_and_serde_boundaries_refuse_incapable_conversions() {
    for text in [r#""\ud800""#, r#"["\udc00"]"#, r#"{"nested":{"\ud800":1}}"#] {
        let value = parse(text).unwrap();
        assert_eq!(serde_json::Value::try_from(&value), Err(Utf16Error));
    }
    for text in [r#""\ud800""#, r#"[1,["\udc00"]]"#] {
        let value = parse(text).unwrap();
        assert_eq!(value.to_js_string(), Err(Utf16Error));
    }
    let value = parse(r#"{"text":"\ud800"}"#).unwrap();
    assert_eq!(value.as_obj().unwrap().try_text("text"), Err(Utf16Error));
    let ordinary = parse(r#"{"😀":"\ud83d\ude00","nested":["é",null]}"#).unwrap();
    assert_eq!(
        serde_json::Value::try_from(&ordinary).unwrap(),
        serde_json::json!({"😀":"😀","nested":["é",null]})
    );
}

#[test]
fn every_utf16_unit_round_trips_without_a_reserved_sentinel() {
    for unit in 0..=u16::MAX {
        let input = format!(r#""\u{unit:04x}""#);
        let value = parse(&input).unwrap();
        assert_eq!(value.to_js_text().units().collect::<Vec<_>>(), [unit]);
        assert_eq!(parse(&value.compact()).unwrap(), value, "{unit:04x}");
    }
}

#[test]
fn utf16_key_lookup_remove_and_pair_normalization_keep_identity() {
    let high = JsString::from_utf16(vec![0xd800]);
    let low = JsString::from_utf16(vec![0xdc00]);
    let pair = JsString::join(&[high.clone(), low.clone()], "");
    assert_eq!(pair, JsString::from("𐀀"));
    let mut obj = Obj::new();
    obj.set(&high, Js::Num(1.0));
    obj.set(&low, Js::Num(2.0));
    obj.set(&pair, Js::Num(3.0));
    obj.set("𐀀", Js::Num(4.0));
    assert_eq!(obj.len(), 3);
    assert_eq!(obj.get(&high), Some(&Js::Num(1.0)));
    assert_eq!(obj.remove(&low), Some(Js::Num(2.0)));
    assert!(!obj.has(&low));
    assert_eq!(obj.get(&pair), Some(&Js::Num(4.0)));
    assert_eq!(
        parse(r#"["\ud800",null,["\udc00"]]"#)
            .unwrap()
            .to_js_text()
            .units()
            .collect::<Vec<_>>(),
        [0xd800, 44, 44, 0xdc00]
    );
}
