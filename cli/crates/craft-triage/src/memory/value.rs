//! A kept finding as the review's memory reads it, and back: the memory matches on plain JSON, so
//! each finding goes to it as `siftFinding` spreads it — its own fields, its stable id, file and
//! line, its detail as the `why` the judges compare, an empty `memoryNote` — with its place in the
//! batch, by which what the memory returns is read back onto the finding itself. A text's unpaired
//! surrogate reaches the memory as U+FFFD; the finding read back keeps every code unit.

use craft_store::js::{Js, JsString};
use serde_json::{Map, Number, Value};

use super::NOTE;
use crate::sift::Sifted;

/// The field naming a finding's place in the batch.
const AT: &str = "siftAt";

/// A JavaScript value as plain JSON, every number a float: the numbers the memory reads (the
/// line, the place) are set apart as integers.
fn plain(v: &Js) -> Value {
    match v {
        Js::Null => Value::Null,
        Js::Bool(b) => Value::Bool(*b),
        Js::Num(n) => Number::from_f64(*n).map_or(Value::Null, Value::Number),
        Js::Str(s) => Value::String(s.to_utf8_lossy()),
        Js::Arr(a) => Value::Array(a.iter().map(plain).collect()),
        Js::Obj(o) => Value::Object(
            o.iter()
                .map(|(k, v)| (k.to_utf8_lossy(), plain(v)))
                .collect(),
        ),
    }
}

/// Each of `kept` as the memory reads it, with its place in the batch.
#[must_use]
pub fn as_values(kept: &[Sifted]) -> Vec<Value> {
    kept.iter()
        .enumerate()
        .map(|(at, s)| {
            let mut o: Map<String, Value> = match plain(&Js::Obj(s.finding.0.clone())) {
                Value::Object(o) => o,
                Value::Null
                | Value::Bool(_)
                | Value::Number(_)
                | Value::String(_)
                | Value::Array(_) => Map::new(),
            };
            let detail = s.finding.0.get("detail").map_or(Value::Null, plain);
            o.insert(
                "stable_id".into(),
                Value::String(s.stable_id.to_utf8_lossy()),
            );
            o.insert("file".into(), Value::String(s.file.to_utf8_lossy()));
            o.insert("line".into(), Value::from(s.line));
            o.insert("why".into(), detail);
            o.insert(NOTE.into(), Value::String(String::new()));
            o.insert(AT.into(), Value::from(at));
            Value::Object(o)
        })
        .collect()
}

/// The finding of `kept` that `f` stands for, with the marks the memory appended to its note.
pub(super) fn sifted_of(kept: &[Sifted], f: &Value) -> Option<Sifted> {
    let at = usize::try_from(f.get(AT)?.as_u64()?).ok()?;
    let mut s = kept.get(at)?.clone();
    let note = f.get(NOTE).and_then(Value::as_str).unwrap_or("");
    s.memory_note = JsString::from(note);
    Some(s)
}
