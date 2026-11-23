use super::*;

fn parse(s: &str) -> Json {
    serde_json::from_str(s).unwrap()
}

#[test]
fn an_object_keeps_its_key_order_through_a_round_trip() {
    let text = r#"{"z":1,"a":[true,null,{"y":"x","b":2.5}],"m":"t"}"#;
    assert_eq!(serde_json::to_string(&parse(text)).unwrap(), text);
}

#[test]
fn set_replaces_in_place_and_appends_what_is_new() {
    let o = Obj::new()
        .with("a", 1usize)
        .with("b", "x")
        .with("a", "y")
        .with("c", true);
    assert_eq!(
        serde_json::to_string(&Json::Object(o)).unwrap(),
        r#"{"a":"y","b":"x","c":true}"#
    );
}

#[test]
fn a_key_given_twice_keeps_its_first_place_and_last_value() {
    assert_eq!(
        serde_json::to_string(&parse(r#"{"a":1,"b":2,"a":3}"#)).unwrap(),
        r#"{"a":3,"b":2}"#
    );
}

#[test]
fn reads_say_what_they_find() {
    let v = parse(r#"{"s":"t","n":1,"o":{"k":"v"},"a":[1]}"#);
    assert_eq!(v.at("s").as_str(), Some("t"));
    assert_eq!(v.at("missing"), &Json::Null);
    assert_eq!(v.at("o").at("k").as_str(), Some("v"));
    assert_eq!(v.at("a").as_array().map(<[Json]>::len), Some(1));
    assert_eq!(v.as_object().map(|o| o.text("n")), Some(""));
    assert_eq!(Json::from("x").at("s"), &Json::Null);
}
