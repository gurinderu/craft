//! The ledger's rows and the validators' verdicts, as `triage-findings.js` keeps them: a prior
//! run's settled verdict carried rather than judged again, and the stand-in for a validator that
//! died, marked so no later run carries it as settled.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::TriageError;

/// The mark on a `needs-decision` nothing judged; a carry-forward prefixes the reason, so the
/// test is `contains`.
pub const UNJUDGED_MARKER: &str = "NOT JUDGED";

/// One ledger row: a finding's final verdict and its one-line reason.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LedgerEntry {
    pub stable_id: String,
    pub verdict: String,
    #[serde(default)]
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sifted: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat_of: Option<String>,
}

/// One validator's verdict on one finding (`content/schemas/triage-validation.schema.json`), and
/// the `action` a noise class adds.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Validation {
    pub stable_id: String,
    pub verdict: String,
    pub reason: String,
    #[serde(default)]
    pub fix_pointer: String,
    #[serde(default)]
    pub premise_checked: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub noise_class: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub severity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
}

impl Validation {
    /// A validator's answer read.
    ///
    /// # Errors
    /// [`TriageError::Answer`] when it is not the validation schema's shape.
    pub fn read(answer: &Value) -> Result<Self, TriageError> {
        serde_json::from_value(answer.clone())
            .map_err(|e| TriageError::answer("a validator's answer", &e))
    }

    /// A prior ledger's settled row carried: no agent, so no fresh premise check.
    #[must_use]
    pub fn carried(prior: &LedgerEntry) -> Self {
        Self {
            stable_id: prior.stable_id.clone(),
            verdict: prior.verdict.clone(),
            reason: format!("carried from prior run: {}", prior.reason),
            premise_checked: "(carried from prior run — not re-checked)".into(),
            ..Self::default()
        }
    }

    /// The verdict of a finding whose validator died: unjudged, so a human looks at it.
    #[must_use]
    pub fn unjudged(id: &str) -> Self {
        Self {
            stable_id: id.to_owned(),
            verdict: "needs-decision".into(),
            reason: format!(
                "{UNJUDGED_MARKER} — the validator agent died; this finding was never checked against the code"
            ),
            premise_checked: "(validator died — nothing was opened)".into(),
            ..Self::default()
        }
    }

    /// The verdict as a ledger row.
    #[must_use]
    pub fn row(&self) -> LedgerEntry {
        LedgerEntry {
            stable_id: self.stable_id.clone(),
            verdict: self.verdict.clone(),
            reason: self.reason.clone(),
            action: self.action.clone(),
            ..LedgerEntry::default()
        }
    }
}

#[cfg(test)]
mod tests;
