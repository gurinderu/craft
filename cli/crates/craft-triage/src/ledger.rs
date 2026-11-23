//! The ledger's rows and the validators' verdicts, kept as the engine keeps them: one object
//! each, its keys in the engine's order, a validator's answer as it came and a verdict the engine
//! settled spread over it; the stand-in for a dead validator is marked so no later run carries it
//! as settled.

use craft_store::js::{Js, Obj};

use crate::TriageError;
use crate::field;

/// The mark on a `needs-decision` nothing judged; a carry-forward prefixes the reason, so the
/// test is `contains`.
pub const UNJUDGED_MARKER: &str = "NOT JUDGED";

/// The fields `content/schemas/triage-validation.schema.json` requires as text; it also requires
/// a numeric [`NUMBER_FIELD`].
pub const TEXT_FIELDS: [&str; 6] = [
    "stable_id",
    "verdict",
    "reason",
    "fix_pointer",
    "premise_checked",
    "severity",
];
/// The number the validation schema requires.
pub const NUMBER_FIELD: &str = "noise_class";

/// One ledger row or one verdict: an object whose keys keep the engine's order.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Row(pub Obj);

impl Row {
    /// A field's text, '' when absent or no string.
    #[must_use]
    pub fn text(&self, key: &str) -> &str {
        field::text(&self.0, key)
    }

    /// A field as `String()` writes it (`undefined` when absent).
    #[must_use]
    pub fn js(&self, key: &str) -> String {
        field::js(&self.0, key)
    }

    /// The stable id.
    #[must_use]
    pub fn id(&self) -> &str {
        self.text("stable_id")
    }

    /// The verdict.
    #[must_use]
    pub fn verdict(&self) -> &str {
        self.text("verdict")
    }

    /// The row with `key` set as `{ ...row, key: v }` sets it.
    #[must_use]
    pub fn with(self, key: &str, v: Js) -> Self {
        Self(self.0.with(key, v))
    }

    /// A validator's answer read.
    ///
    /// # Errors
    /// [`TriageError::Answer`] when it is no object or lacks a field the validation schema
    /// requires: its six text fields and a numeric `noise_class`.
    pub fn validation(answer: &Js) -> Result<Self, TriageError> {
        let refused = |why: String| TriageError::Answer {
            what: "a validator's answer".into(),
            why,
        };
        let o = answer.as_obj().ok_or_else(|| refused("no object".into()))?;
        if let Some(k) = TEXT_FIELDS
            .iter()
            .find(|k| o.get(**k).and_then(Js::as_str).is_none())
        {
            return Err(refused(format!("no text {k}")));
        }
        if o.get(NUMBER_FIELD).and_then(Js::as_num).is_none() {
            return Err(refused(format!("no numeric {NUMBER_FIELD}")));
        }
        Ok(Self(o.clone()))
    }

    /// A prior ledger's settled row carried: no agent, so no fresh premise check.
    #[must_use]
    pub fn carried(prior: &Self) -> Self {
        let reason = format!("carried from prior run: {}", prior.js("reason"));
        Self(
            Obj::new()
                .with("stable_id", Js::str(prior.id()))
                .with("verdict", Js::str(prior.js("verdict")))
                .with("reason", Js::str(reason))
                .with("fix_pointer", Js::str(""))
                .with(
                    "premise_checked",
                    Js::str("(carried from prior run — not re-checked)"),
                ),
        )
    }

    /// The verdict of a finding whose validator died: unjudged, so a human looks at it.
    #[must_use]
    pub fn unjudged(id: &str) -> Self {
        let reason = format!(
            "{UNJUDGED_MARKER} — the validator agent died; this finding was never checked against the code"
        );
        Self(
            Obj::new()
                .with("stable_id", Js::str(id))
                .with("verdict", Js::str("needs-decision"))
                .with("reason", Js::str(reason))
                .with("fix_pointer", Js::str(""))
                .with(
                    "premise_checked",
                    Js::str("(validator died — nothing was opened)"),
                ),
        )
    }
}

impl From<Row> for Js {
    fn from(r: Row) -> Self {
        Self::Obj(r.0)
    }
}

#[cfg(test)]
mod tests;
