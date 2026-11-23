//! A JSON value that keeps its keys in the order they came, as a JavaScript object does: the
//! triage's rows, verdicts and plan are the engine's objects, spread and extended in place, and the
//! run record is written byte for byte as the engine hands it over (realm @nick/craft, node #616).
//! `serde_json`'s own `Value` sorts its keys in this workspace (no `preserve_order`), and turning
//! that feature on would reorder every other crate's maps with it.

mod wire;

/// One JSON value; an object keeps its keys in order.
#[derive(Debug, Clone, Default, PartialEq)]
pub enum Json {
    #[default]
    Null,
    Bool(bool),
    Number(serde_json::Number),
    String(String),
    Array(Vec<Json>),
    Object(Obj),
}

/// A JSON object, its keys in the order they were first set.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Obj(Vec<(String, Json)>);

static NULL: Json = Json::Null;

impl Obj {
    /// An empty object.
    #[must_use]
    pub const fn new() -> Self {
        Self(Vec::new())
    }

    /// The value under `key`, `None` when it is absent (JavaScript's `undefined`).
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&Json> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    /// Its keys, in order.
    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.0.iter().map(|(k, _)| k.as_str())
    }

    /// The text under `key`, '' when it is absent or no string.
    #[must_use]
    pub fn text(&self, key: &str) -> &str {
        self.get(key).and_then(Json::as_str).unwrap_or("")
    }

    /// `key` set as `{ ...o, key: v }` sets it: in place when present, else appended.
    pub fn set(&mut self, key: &str, v: impl Into<Json>) {
        let v = v.into();
        match self.0.iter_mut().find(|(k, _)| k == key) {
            Some((_, old)) => *old = v,
            None => self.0.push((key.to_owned(), v)),
        }
    }

    /// The object with `key` set.
    #[must_use]
    pub fn with(mut self, key: &str, v: impl Into<Json>) -> Self {
        self.set(key, v);
        self
    }
}

impl IntoIterator for Obj {
    type Item = (String, Json);
    type IntoIter = std::vec::IntoIter<(String, Json)>;

    fn into_iter(self) -> Self::IntoIter {
        self.0.into_iter()
    }
}

impl Json {
    /// The string, when this is one.
    #[must_use]
    pub fn as_str(&self) -> Option<&str> {
        if let Self::String(s) = self {
            Some(s)
        } else {
            None
        }
    }

    /// The object, when this is one.
    #[must_use]
    pub const fn as_object(&self) -> Option<&Obj> {
        if let Self::Object(o) = self {
            Some(o)
        } else {
            None
        }
    }

    /// The array, when this is one.
    #[must_use]
    pub fn as_array(&self) -> Option<&[Self]> {
        if let Self::Array(a) = self {
            Some(a)
        } else {
            None
        }
    }

    /// The value under `key` of an object; `Null` for anything else.
    #[must_use]
    pub fn at(&self, key: &str) -> &Self {
        self.as_object().and_then(|o| o.get(key)).unwrap_or(&NULL)
    }
}

impl From<&str> for Json {
    fn from(s: &str) -> Self {
        Self::String(s.to_owned())
    }
}
impl From<String> for Json {
    fn from(s: String) -> Self {
        Self::String(s)
    }
}
impl From<bool> for Json {
    fn from(b: bool) -> Self {
        Self::Bool(b)
    }
}
impl From<usize> for Json {
    fn from(n: usize) -> Self {
        Self::Number(serde_json::Number::from(n))
    }
}
impl From<Obj> for Json {
    fn from(o: Obj) -> Self {
        Self::Object(o)
    }
}
impl<T: Into<Self>> From<Vec<T>> for Json {
    fn from(v: Vec<T>) -> Self {
        Self::Array(v.into_iter().map(Into::into).collect())
    }
}

#[cfg(test)]
mod tests;
