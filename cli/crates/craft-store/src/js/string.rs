//! JavaScript strings carry UTF-16 code units, including unpaired surrogates (#560).

/// A string's code units. Well-formed UTF-16 is stored as UTF-8; the other representation is private
/// so equal code-unit sequences always have the same representation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsString(Repr);

#[derive(Debug, Clone, PartialEq, Eq)]
enum Repr {
    Utf8(String),
    Units(Vec<u16>),
}

/// A JavaScript string cannot cross a Unicode-only boundary without losing a code unit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("unpaired UTF-16 surrogate cannot be represented as UTF-8")]
pub struct Utf16Error;

impl Default for JsString {
    fn default() -> Self {
        Self::from("")
    }
}

impl JsString {
    #[must_use]
    pub fn from_utf16(units: Vec<u16>) -> Self {
        match String::from_utf16(&units) {
            Ok(s) => Self::from(s),
            Err(_) => Self(Repr::Units(units)),
        }
    }

    /// The Unicode view, absent for a string containing any unpaired surrogate.
    #[must_use]
    pub fn as_str(&self) -> Option<&str> {
        match &self.0 {
            Repr::Utf8(s) => Some(s),
            Repr::Units(_) => None,
        }
    }

    /// # Errors
    /// When any code unit is an unpaired surrogate; no replacement is made.
    pub fn to_utf8(&self) -> Result<String, Utf16Error> {
        self.as_str().map(str::to_owned).ok_or(Utf16Error)
    }

    pub fn units(&self) -> impl Iterator<Item = u16> + '_ {
        let (text, units) = match &self.0 {
            Repr::Utf8(s) => (Some(s.as_str()), None),
            Repr::Units(u) => (None, Some(u.as_slice())),
        };
        text.into_iter()
            .flat_map(str::encode_utf16)
            .chain(units.into_iter().flatten().copied())
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.units().next().is_none()
    }

    #[must_use]
    pub fn starts_with(&self, prefix: &str) -> bool {
        let mut units = self.units();
        prefix.encode_utf16().all(|u| Some(u) == units.next())
    }

    #[must_use]
    pub fn ends_with(&self, suffix: &str) -> bool {
        self.units()
            .collect::<Vec<_>>()
            .ends_with(&suffix.encode_utf16().collect::<Vec<_>>())
    }

    #[must_use]
    pub fn contains(&self, needle: &str) -> bool {
        let needle: Vec<_> = needle.encode_utf16().collect();
        needle.is_empty()
            || self
                .units()
                .collect::<Vec<_>>()
                .windows(needle.len())
                .any(|w| w == needle)
    }

    #[must_use]
    pub fn join(parts: &[Self], separator: &str) -> Self {
        let mut units = Vec::new();
        for (i, part) in parts.iter().enumerate() {
            if i != 0 {
                units.extend(separator.encode_utf16());
            }
            units.extend(part.units());
        }
        Self::from_utf16(units)
    }

    /// Transform Unicode runs without interpreting or replacing the unpaired units between them.
    #[must_use]
    pub fn map_unicode(&self, f: impl Fn(&str) -> String) -> Self {
        let mut out = Vec::new();
        let mut run = String::new();
        for c in char::decode_utf16(self.units()) {
            match c {
                Ok(c) => run.push(c),
                Err(e) => {
                    out.extend(f(&run).encode_utf16());
                    run.clear();
                    out.push(e.unpaired_surrogate());
                }
            }
        }
        out.extend(f(&run).encode_utf16());
        Self::from_utf16(out)
    }
}

impl From<&&str> for JsString {
    fn from(s: &&str) -> Self {
        Self::from(*s)
    }
}

impl From<String> for JsString {
    fn from(s: String) -> Self {
        Self(Repr::Utf8(s))
    }
}

impl From<&str> for JsString {
    fn from(s: &str) -> Self {
        Self::from(s.to_owned())
    }
}

impl From<&String> for JsString {
    fn from(s: &String) -> Self {
        Self::from(s.as_str())
    }
}

impl From<&Self> for JsString {
    fn from(s: &Self) -> Self {
        s.clone()
    }
}

impl PartialEq<str> for JsString {
    fn eq(&self, s: &str) -> bool {
        self.as_str() == Some(s)
    }
}

impl PartialEq<&str> for JsString {
    fn eq(&self, s: &&str) -> bool {
        self == *s
    }
}

impl PartialEq<String> for JsString {
    fn eq(&self, s: &String) -> bool {
        self == s.as_str()
    }
}

impl PartialOrd for JsString {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for JsString {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.units().cmp(other.units())
    }
}
