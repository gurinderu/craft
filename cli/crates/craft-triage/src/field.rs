//! Reading the fields of the store's JavaScript-compatible values (`craft_store::js`) as the
//! engine reads them.

use craft_store::js::{Js, JsString, Obj};

static NULL: Js = Js::Null;

/// The value under `key` of an object; `Null` for anything else or an absent key.
#[must_use]
pub fn at<'a>(v: &'a Js, key: &str) -> &'a Js {
    v.as_obj().and_then(|o| o.get(key)).unwrap_or(&NULL)
}

/// [`at`] as a method, for a path of keys.
pub trait At {
    /// The value under `key`; `Null` when `self` is no object or lacks it.
    fn at(&self, key: &str) -> &Js;
}

impl At for Js {
    fn at(&self, key: &str) -> &Js {
        at(self, key)
    }
}

/// The text under `key`, '' when it is absent, no string, or holds an unpaired surrogate.
#[must_use]
pub fn text<'a>(o: &'a Obj, key: &str) -> &'a str {
    o.get(key).and_then(Js::as_str).unwrap_or("")
}

/// `String(o[key])` as a template literal writes it, `undefined` when absent; an unpaired
/// surrogate, which UTF-8 cannot hold, is written as U+FFFD.
#[must_use]
pub fn js(o: &Obj, key: &str) -> String {
    o.get(key).map_or_else(|| "undefined".into(), string)
}

/// `String(v)`, an unpaired surrogate written as U+FFFD.
#[must_use]
pub fn string(v: &Js) -> String {
    let t: JsString = v.to_js_text();
    t.to_utf8()
        .unwrap_or_else(|_| String::from_utf16_lossy(&t.units().collect::<Vec<_>>()))
}

/// `o[key] ?? ''` as a template literal writes it.
#[must_use]
pub fn or_empty(o: &Obj, key: &str) -> String {
    match o.get(key) {
        None | Some(Js::Null) => String::new(),
        Some(v) => string(v),
    }
}

/// Whether `o[key]` is truthy; absent is not.
#[must_use]
pub fn truthy(o: &Obj, key: &str) -> bool {
    o.get(key).is_some_and(Js::truthy)
}

/// A count as JavaScript holds a number.
#[must_use]
pub fn num(n: usize) -> Js {
    Js::Num(f64::from(u32::try_from(n).unwrap_or(u32::MAX)))
}

/// A list of text.
#[must_use]
pub fn texts(v: &[String]) -> Js {
    Js::Arr(v.iter().map(|s| Js::str(s.as_str())).collect())
}

#[cfg(test)]
mod tests {
    use craft_store::js::parse;

    use super::*;

    #[test]
    fn fields_read_as_the_engine_reads_them() {
        let v = parse(r#"{"s":"t","n":6.0,"z":null,"o":{"k":"v"},"bad":"\ud800"}"#).unwrap();
        let o = v.as_obj().unwrap();
        assert_eq!(text(o, "s"), "t");
        assert_eq!(text(o, "n"), "");
        assert_eq!(text(o, "bad"), "");
        assert_eq!(js(o, "n"), "6");
        assert_eq!(js(o, "missing"), "undefined");
        assert_eq!(js(o, "bad"), "\u{fffd}");
        assert_eq!(or_empty(o, "z"), "");
        assert_eq!(or_empty(o, "n"), "6");
        assert!(truthy(o, "s") && !truthy(o, "z") && !truthy(o, "missing"));
        assert_eq!(at(at(&v, "o"), "k").as_str(), Some("v"));
        assert_eq!(at(&v, "missing"), &Js::Null);
        assert_eq!(num(3).compact(), "3");
        assert_eq!(texts(&["a".into()]).compact(), r#"["a"]"#);
    }

    #[test]
    fn an_integral_float_is_written_as_json_stringify_writes_it() {
        let v = parse(r#"{"noise_class":6.0,"x":1e2,"y":2.5}"#).unwrap();
        assert_eq!(v.compact(), r#"{"noise_class":6,"x":100,"y":2.5}"#);
    }
}
