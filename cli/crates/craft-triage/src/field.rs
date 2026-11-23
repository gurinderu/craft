//! Reading the fields of the store's JavaScript-compatible values (`craft_store::js`) as the
//! engine reads them.

use std::borrow::Cow;

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

/// The text under `key`, '' when it is absent or no string. A string holding an unpaired
/// surrogate is text all the same, as the engine reads it; UTF-8 cannot hold the surrogate, which
/// reads as U+FFFD.
#[must_use]
pub fn text<'a>(o: &'a Obj, key: &str) -> Cow<'a, str> {
    match o.get(key) {
        Some(Js::Str(s)) => s
            .as_str()
            .map_or_else(|| Cow::Owned(lossy(s)), Cow::Borrowed),
        _ => Cow::Borrowed(""),
    }
}

/// A JavaScript string as UTF-8, an unpaired surrogate as U+FFFD.
fn lossy(s: &JsString) -> String {
    String::from_utf16_lossy(&s.units().collect::<Vec<_>>())
}

/// `String(o[key])` as a template literal writes it, `undefined` when absent, every UTF-16
/// code unit kept.
#[must_use]
pub fn js_text(o: &Obj, key: &str) -> JsString {
    o.get(key)
        .map_or_else(|| "undefined".into(), Js::to_js_text)
}

/// `o[key] ?? ''` as a template literal writes it, every UTF-16 code unit kept.
#[must_use]
pub fn or_empty_text(o: &Obj, key: &str) -> JsString {
    match o.get(key) {
        None | Some(Js::Null) => JsString::default(),
        Some(v) => v.to_js_text(),
    }
}

/// The pieces of a template literal joined, every UTF-16 code unit kept.
#[must_use]
pub fn cat(parts: &[JsString]) -> JsString {
    JsString::join(parts, "")
}

/// [`js_text`] as UTF-8, an unpaired surrogate written as U+FFFD.
#[must_use]
pub fn js(o: &Obj, key: &str) -> String {
    utf8(&js_text(o, key))
}

/// [`or_empty_text`] as UTF-8, an unpaired surrogate written as U+FFFD.
#[must_use]
pub fn or_empty(o: &Obj, key: &str) -> String {
    utf8(&or_empty_text(o, key))
}

/// A JavaScript string as UTF-8, an unpaired surrogate written as U+FFFD.
#[must_use]
pub fn utf8(t: &JsString) -> String {
    t.to_utf8().unwrap_or_else(|_| lossy(t))
}

/// Whether `o[key]` is truthy; absent is not.
#[must_use]
pub fn truthy(o: &Obj, key: &str) -> bool {
    o.get(key).is_some_and(Js::truthy)
}

/// A count as JavaScript holds a number: a double.
#[must_use]
#[expect(
    clippy::cast_precision_loss,
    reason = "a JavaScript count is a double; one past 2^53 rounds there too"
)]
pub fn num(n: usize) -> Js {
    Js::Num(n as f64)
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
        assert_eq!(text(o, "bad"), "\u{fffd}");
        assert_eq!(js(o, "n"), "6");
        assert_eq!(js(o, "missing"), "undefined");
        assert_eq!(js(o, "bad"), "\u{fffd}");
        assert_eq!(js_text(o, "bad"), JsString::from_utf16(vec![0xd800]));
        assert_eq!(cat(&["a".into(), js_text(o, "n")]), "a6");
    }

    #[test]
    fn empties_truthiness_paths_and_counts_read_as_the_engine_reads_them() {
        let v = parse(r#"{"s":"t","n":6.0,"z":null,"o":{"k":"v"}}"#).unwrap();
        let o = v.as_obj().unwrap();
        assert_eq!(or_empty(o, "z"), "");
        assert_eq!(or_empty(o, "n"), "6");
        assert!(truthy(o, "s") && !truthy(o, "z") && !truthy(o, "missing"));
        assert_eq!(at(at(&v, "o"), "k").as_str(), Some("v"));
        assert_eq!(at(&v, "missing"), &Js::Null);
        assert_eq!(num(3).compact(), "3");
        assert_eq!(num(5_000_000_000).compact(), "5000000000");
        assert_eq!(texts(&["a".into()]).compact(), r#"["a"]"#);
    }

    #[test]
    fn an_integral_float_is_written_as_json_stringify_writes_it() {
        let v = parse(r#"{"noise_class":6.0,"x":1e2,"y":2.5}"#).unwrap();
        assert_eq!(v.compact(), r#"{"noise_class":6,"x":100,"y":2.5}"#);
    }
}
