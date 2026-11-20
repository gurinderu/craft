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
    let got: Vec<String> = v.as_arr().unwrap().iter().map(Js::to_js_string).collect();
    assert_eq!(got, ["null", "true", "3", "s", "1,,2", "[object Object]"]);
}
#[test]
fn lone_surrogates_are_not_silently_replaced() {
    for input in [r#""\ud800""#, r#""\udc00""#, r#"{"\ud800":1,"\ud801":2}"#] {
        assert!(super::parse(input).is_err(), "{input}");
    }
    assert_eq!(
        super::parse(r#""\ud83d\ude00""#).unwrap().to_js_string(),
        "😀"
    );
}
