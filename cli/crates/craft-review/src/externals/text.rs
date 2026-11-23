use craft_store::js::{Js, JsString};

pub(super) fn field(v: &Js, key: &str) -> JsString {
    v.as_obj().map(|o| o.text_units(key)).unwrap_or_default()
}

pub(super) fn join(parts: &[JsString]) -> JsString {
    JsString::join(parts, "")
}

pub(super) fn slice(s: &JsString, len: usize) -> JsString {
    JsString::from_utf16(s.units().take(len).collect())
}

pub(super) fn ref_fault(s: &JsString) -> Option<String> {
    if s.units().count() > 128 {
        return Some("revision over 128 characters".into());
    }
    if s.units().any(|u| u > 127) {
        return Some(
            "revision outside [A-Za-z0-9._+/-] or starting with a non-alphanumeric".into(),
        );
    }
    crate::sources::spec::ref_fault(&s.to_utf8_lossy())
}
