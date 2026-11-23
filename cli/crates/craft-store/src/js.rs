//! A JSON value as JavaScript holds it, so the store's bytes come out as `integrations/shared/craft-log-run.mjs`
//! writes them: every number a double, and an object's keys in JavaScript's own order — the keys
//! that are array indices first, ascending, then the rest in the order they were first set. A key
//! set again keeps its place. `serde_json`'s map sorts its keys, so it cannot carry that order.

mod coerce;
mod number;
mod parse;
mod string;
mod write;

pub use coerce::{JsStr, SPACE_CLASS, is_space, is_space_unit, number_of_text, trim, trim_text};
pub use number::number_text;
pub use parse::{ParseError, parse};
pub use string::{JsString, Utf16Error};

/// One JSON value.
#[derive(Debug, Clone, PartialEq)]
pub enum Js {
    Null,
    Bool(bool),
    Num(f64),
    Str(JsString),
    Arr(Vec<Js>),
    Obj(Obj),
}

/// An object, its keys in JavaScript's order.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Obj(Vec<(JsString, Js)>);

/// Whether `k` is an array index as JavaScript orders object keys: a canonical decimal below 2³²−1.
fn is_index(k: &JsString) -> Option<u32> {
    let k = k.as_str()?;
    let n: u32 = k.parse().ok()?;
    (n != u32::MAX && n.to_string() == k).then_some(n)
}

impl Obj {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets `k` to `v`: in its place when it is there, else where JavaScript puts a new key.
    pub fn set(&mut self, k: impl Into<JsString>, v: Js) {
        let k = k.into();
        if let Some(slot) = self.0.iter_mut().find(|(have, _)| *have == k) {
            slot.1 = v;
            return;
        }
        let at = match is_index(&k) {
            Some(n) => self
                .0
                .iter()
                .position(|(have, _)| is_index(have).is_none_or(|m| m > n))
                .unwrap_or(self.0.len()),
            None => self.0.len(),
        };
        self.0.insert(at, (k, v));
    }

    /// `self` with `k` set, for building an object in one expression.
    #[must_use]
    pub fn with(mut self, k: &str, v: Js) -> Self {
        self.set(k, v);
        self
    }

    /// Every key of `other` set over `self`, as `{ ...self, ...other }`.
    pub fn spread(&mut self, other: &Obj) {
        for (k, v) in &other.0 {
            self.set(k.clone(), v.clone());
        }
    }

    #[must_use]
    pub fn get<K: ?Sized>(&self, k: &K) -> Option<&Js>
    where
        JsString: PartialEq<K>,
    {
        self.0.iter().find(|(have, _)| have == k).map(|(_, v)| v)
    }

    pub fn remove<K: ?Sized>(&mut self, k: &K) -> Option<Js>
    where
        JsString: PartialEq<K>,
    {
        let i = self.0.iter().position(|(have, _)| have == k)?;
        Some(self.0.remove(i).1)
    }

    #[must_use]
    pub fn has<K: ?Sized>(&self, k: &K) -> bool
    where
        JsString: PartialEq<K>,
    {
        self.get(k).is_some()
    }

    pub fn iter(&self) -> impl ExactSizeIterator<Item = (&JsString, &Js)> {
        self.0.iter().map(|(k, v)| (k, v))
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// The string at `k`, `""` when absent or not a string.
    /// # Errors
    /// When its code units cannot be represented as UTF-8. Use `text_units` for stored data.
    pub fn text(&self, k: &str) -> Result<&str, Utf16Error> {
        self.try_text(k)
    }

    /// `typeof o[k] === 'string' ? o[k] : ''`, without narrowing JavaScript's strings.
    #[must_use]
    pub fn text_units(&self, k: &str) -> JsString {
        self.get(k)
            .filter(|v| v.is_string())
            .map(Js::to_js_text)
            .unwrap_or_default()
    }

    /// # Errors
    /// When the field is a string containing an unpaired surrogate.
    pub fn try_text(&self, k: &str) -> Result<&str, Utf16Error> {
        match self.get(k) {
            Some(Js::Str(s)) => s.as_str().ok_or(Utf16Error),
            _ => Ok(""),
        }
    }
}

impl Js {
    #[must_use]
    pub fn str(s: impl Into<JsString>) -> Self {
        Self::Str(s.into())
    }

    #[must_use]
    pub fn is_string(&self) -> bool {
        matches!(self, Self::Str(_))
    }

    #[must_use]
    pub fn as_str(&self) -> Option<&str> {
        if let Self::Str(s) = self {
            s.as_str()
        } else {
            None
        }
    }

    #[must_use]
    pub fn as_obj(&self) -> Option<&Obj> {
        if let Self::Obj(o) = self {
            Some(o)
        } else {
            None
        }
    }

    #[must_use]
    pub fn as_arr(&self) -> Option<&[Js]> {
        if let Self::Arr(a) = self {
            Some(a)
        } else {
            None
        }
    }

    #[must_use]
    pub fn as_num(&self) -> Option<f64> {
        if let Self::Num(n) = self {
            Some(*n)
        } else {
            None
        }
    }

    /// JavaScript's truthiness.
    #[must_use]
    pub fn truthy(&self) -> bool {
        match self {
            Self::Null => false,
            Self::Bool(b) => *b,
            Self::Num(n) => *n != 0.0 && !n.is_nan(),
            Self::Str(s) => !s.is_empty(),
            Self::Arr(_) | Self::Obj(_) => true,
        }
    }

    /// `String(v)` as UTF-8.
    ///
    /// # Errors
    /// When the JavaScript result contains an unpaired surrogate. Use `to_js_text` to retain it.
    pub fn to_js_string(&self) -> Result<String, Utf16Error> {
        self.to_js_text().to_utf8()
    }

    /// `String(v)` without narrowing JavaScript's string domain.
    #[must_use]
    pub fn to_js_text(&self) -> JsString {
        match self {
            Self::Null => "null".into(),
            Self::Bool(b) => b.to_string().into(),
            Self::Num(n) => number_text(*n).into(),
            Self::Str(s) => s.clone(),
            Self::Arr(a) => JsString::join(
                &a.iter()
                    .map(|v| {
                        if *v == Self::Null {
                            JsString::default()
                        } else {
                            v.to_js_text()
                        }
                    })
                    .collect::<Vec<_>>(),
                ",",
            ),
            Self::Obj(_) => "[object Object]".into(),
        }
    }

    /// `JSON.stringify(v)`.
    #[must_use]
    pub fn compact(&self) -> String {
        write::compact(self)
    }

    /// `JSON.stringify(v, null, 2)`.
    #[must_use]
    pub fn pretty(&self) -> String {
        write::pretty(self)
    }
}

impl From<&serde_json::Value> for Js {
    /// The value JavaScript reads back from `serde_json`'s text of `v`.
    fn from(v: &serde_json::Value) -> Self {
        use serde_json::Value as V;
        match v {
            V::Null => Self::Null,
            V::Bool(b) => Self::Bool(*b),
            V::Number(n) => Self::Num(n.as_f64().unwrap_or(f64::NAN)),
            V::String(s) => Self::str(s),
            V::Array(a) => Self::Arr(a.iter().map(Self::from).collect()),
            V::Object(m) => {
                let mut o = Obj::new();
                for (k, v) in m {
                    o.set(k.clone(), Self::from(v));
                }
                Self::Obj(o)
            }
        }
    }
}

impl TryFrom<&Js> for serde_json::Value {
    type Error = Utf16Error;

    fn try_from(v: &Js) -> Result<Self, Self::Error> {
        use serde_json::Value as V;
        Ok(match v {
            Js::Null => V::Null,
            Js::Bool(b) => V::Bool(*b),
            Js::Num(n) => number::to_serde(*n),
            Js::Str(s) => V::String(s.to_utf8()?),
            Js::Arr(a) => V::Array(a.iter().map(V::try_from).collect::<Result<_, _>>()?),
            Js::Obj(o) => V::Object(
                o.iter()
                    .map(|(k, v)| Ok((k.to_utf8()?, V::try_from(v)?)))
                    .collect::<Result<_, Utf16Error>>()?,
            ),
        })
    }
}

#[cfg(test)]
mod tests;
