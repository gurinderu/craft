//! A JSON value as JavaScript holds it, so the store's bytes come out as `lib/craft-log-run.mjs`
//! writes them: every number a double, and an object's keys in JavaScript's own order — the keys
//! that are array indices first, ascending, then the rest in the order they were first set. A key
//! set again keeps its place. `serde_json`'s map sorts its keys, so it cannot carry that order.

mod number;
mod parse;
mod write;

pub use number::number_text;
pub use parse::{ParseError, parse};

/// One JSON value.
#[derive(Debug, Clone, PartialEq)]
pub enum Js {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Js>),
    Obj(Obj),
}

/// An object, its keys in JavaScript's order.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Obj(Vec<(String, Js)>);

/// Whether `k` is an array index as JavaScript orders object keys: a canonical decimal below 2³²−1.
fn is_index(k: &str) -> Option<u32> {
    let n: u32 = k.parse().ok()?;
    (n != u32::MAX && n.to_string() == k).then_some(n)
}

impl Obj {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets `k` to `v`: in its place when it is there, else where JavaScript puts a new key.
    pub fn set(&mut self, k: impl Into<String>, v: Js) {
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
    pub fn get(&self, k: &str) -> Option<&Js> {
        self.0.iter().find(|(have, _)| have == k).map(|(_, v)| v)
    }

    pub fn remove(&mut self, k: &str) -> Option<Js> {
        let i = self.0.iter().position(|(have, _)| have == k)?;
        Some(self.0.remove(i).1)
    }

    #[must_use]
    pub fn has(&self, k: &str) -> bool {
        self.get(k).is_some()
    }

    pub fn iter(&self) -> impl ExactSizeIterator<Item = (&String, &Js)> {
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

    /// The string at `k`, `""` when it is absent or no string (`typeof … === 'string'`).
    #[must_use]
    pub fn text(&self, k: &str) -> &str {
        self.get(k).and_then(Js::as_str).unwrap_or("")
    }
}

impl Js {
    #[must_use]
    pub fn str(s: impl Into<String>) -> Self {
        Self::Str(s.into())
    }

    #[must_use]
    pub fn as_str(&self) -> Option<&str> {
        if let Self::Str(s) = self {
            Some(s)
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

    /// `String(v)`.
    #[must_use]
    pub fn to_js_string(&self) -> String {
        match self {
            Self::Null => "null".into(),
            Self::Bool(b) => b.to_string(),
            Self::Num(n) => number_text(*n),
            Self::Str(s) => s.clone(),
            Self::Arr(a) => a
                .iter()
                .map(|v| {
                    if *v == Self::Null {
                        String::new()
                    } else {
                        v.to_js_string()
                    }
                })
                .collect::<Vec<_>>()
                .join(","),
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
            V::String(s) => Self::Str(s.clone()),
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

impl From<&Js> for serde_json::Value {
    fn from(v: &Js) -> Self {
        use serde_json::Value as V;
        match v {
            Js::Null => V::Null,
            Js::Bool(b) => V::Bool(*b),
            Js::Num(n) => number::to_serde(*n),
            Js::Str(s) => V::String(s.clone()),
            Js::Arr(a) => V::Array(a.iter().map(V::from).collect()),
            Js::Obj(o) => V::Object(o.iter().map(|(k, v)| (k.clone(), V::from(v))).collect()),
        }
    }
}

#[cfg(test)]
mod tests;
