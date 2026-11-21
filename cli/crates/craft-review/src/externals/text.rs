use craft_store::js::{Js, JsString};

pub(super) fn whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub(super) fn trim(s: &JsString) -> JsString {
    let mut units: Vec<_> = s.units().collect();
    let space = |u: &u16| char::from_u32(u32::from(*u)).is_some_and(whitespace);
    let first = units.iter().position(|u| !space(u)).unwrap_or(units.len());
    units.drain(..first);
    let last = units.iter().rposition(|u| !space(u)).map_or(0, |i| i + 1);
    units.truncate(last);
    JsString::from_utf16(units)
}

pub(super) fn field(v: &Js, key: &str) -> JsString {
    v.as_obj().map(|o| o.text_units(key)).unwrap_or_default()
}

pub(super) fn join(parts: &[JsString]) -> JsString {
    JsString::join(parts, "")
}

pub(super) fn slice(s: &JsString, len: usize) -> JsString {
    JsString::from_utf16(s.units().take(len).collect())
}

pub(super) fn lossy(s: &JsString) -> String {
    String::from_utf16_lossy(&s.units().collect::<Vec<_>>())
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
    crate::sources::spec::ref_fault(&lossy(s))
}
