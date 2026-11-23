//! A gathered finding, as `triage-findings.js` reads one: the source it came from, its stable id,
//! and the file and line its location names.

use std::borrow::Cow;

use craft_store::js::{JsStr, JsString, Obj};

use crate::field;

mod gathered;
mod location;

pub use gathered::Gathered;
pub use location::location_parts;

/// The engines a report's source may name; anything else reads as `report`.
pub const REPORT_SOURCES: [&str; 5] = [
    "review",
    "adversarial-review",
    "rust-audit",
    "rust-reviewer",
    "nix-review",
];

/// What `content/schemas/triage-raw.schema.json` requires of a gatherer's answer.
pub const ANSWER_FIELDS: [&str; 2] = ["source", "findings"];

/// The fields the same schema requires of a finding, all text.
pub const FIELDS: [&str; 6] = [
    "severity",
    "title",
    "location",
    "detail",
    "proposed_fix",
    "thread_id",
];

/// The severities, Critical first (`craft_store::record::SEVERITIES`).
pub use craft_store::record::SEVERITIES;

/// One finding a gatherer returned, its keys in the gatherer's order; once sourced, with the
/// source it came from set on it.
#[derive(Debug, Clone, PartialEq)]
pub struct Finding(pub Obj);

impl Finding {
    /// A field's text, '' when absent or no string.
    #[must_use]
    pub fn text(&self, key: &str) -> Cow<'_, str> {
        field::text(&self.0, key)
    }
}

/// A report's source: the engine that wrote it as the gatherer read it, else `report` (also for
/// a source with an unpaired surrogate, which names no engine).
#[must_use]
pub fn report_source(said: Option<&str>) -> String {
    let said = said.map(str::js_trim).unwrap_or_default();
    if REPORT_SOURCES.contains(&said) {
        said.to_owned()
    } else {
        "report".to_owned()
    }
}

/// The stable composite id: `source::location::title`, `no-loc` for an empty location, every
/// UTF-16 code unit kept.
#[must_use]
pub fn id_of(f: &Finding) -> JsString {
    let location = if field::truthy(&f.0, "location") {
        field::js_text(&f.0, "location")
    } else {
        "no-loc".into()
    };
    let parts = [
        field::js_text(&f.0, "source"),
        location,
        field::js_text(&f.0, "title"),
    ];
    JsString::join(&parts, "::")
}

/// A severity's rank, Critical first, compared without case; an unknown one last.
#[must_use]
pub fn severity_rank(s: &str) -> usize {
    let s = s.js_trim().to_lowercase();
    SEVERITIES
        .iter()
        .position(|x| x.eq_ignore_ascii_case(&s))
        .unwrap_or(SEVERITIES.len())
}

#[cfg(test)]
mod tests;
