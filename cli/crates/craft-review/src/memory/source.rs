//! Where a run's remembered records came from (`MemorySource` in `lib/memory-recall.mjs`; realm
//! @nick/craft, node #250): the line the report names it in, and the run record's copy.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::PriorDecision;

/// How many records whose id was derived the memory line names, and how much of each title.
const DERIVED_NAMED_MAX: usize = 3;

const DERIVED_TITLE_MAX: usize = 40;

/// Where the records came from (`MemorySource`): `recalled`, or `none` and why; `passed` counts
/// the launcher's records accepted alone and `added` those the recall did not already hold;
/// `derived` the applied records whose id was derived, the first few named.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySource {
    pub source: String,
    pub count: usize,
    pub why: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub questions: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rules: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub externals: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passed: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub derived: Option<usize>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub derived_named: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
}

impl Default for MemorySource {
    /// Before any recall (`initialMemory`).
    fn default() -> Self {
        Self::none("not recalled — the run ended before its recall step".into())
    }
}

impl MemorySource {
    pub(super) fn none(why: String) -> Self {
        Self {
            source: "none".into(),
            count: 0,
            why,
            questions: None,
            rules: None,
            externals: None,
            passed: None,
            added: None,
            derived: None,
            derived_named: Vec::new(),
            backend: None,
        }
    }

    /// `n` when it is not 0.
    fn some(n: usize) -> Option<usize> {
        (n > 0).then_some(n)
    }

    /// The open questions, project rules and external systems among the records, each only when
    /// there are any (`kindCounts`).
    pub(super) fn with_kinds(mut self, questions: usize, rules: usize, externals: usize) -> Self {
        self.questions = Self::some(questions);
        self.rules = Self::some(rules);
        self.externals = Self::some(externals).or(self.externals);
        self
    }

    /// `N decision(s)` with its open questions, project rules and external systems
    /// (`countedRecords`).
    fn counted(&self) -> String {
        let (q, r, e) = (
            self.questions.unwrap_or(0),
            self.rules.unwrap_or(0),
            self.externals.unwrap_or(0),
        );
        let external = if e > 0 {
            format!("{e} external system(s)")
        } else {
            String::new()
        };
        if !external.is_empty() && self.count == 0 {
            return external;
        }
        let part = |n: usize, what: &str| {
            if n > 0 {
                format!(" and {n} {what}")
            } else {
                String::new()
            }
        };
        let ext = if external.is_empty() {
            String::new()
        } else {
            format!(" and {external}")
        };
        format!(
            "{} decision(s){}{}{ext}",
            self.count.saturating_sub(q + r),
            part(q, "open question(s)"),
            part(r, "project rule(s)")
        )
    }

    /// The line naming where the records came from and what the launcher added (`memoryLine`).
    #[must_use]
    pub fn line(&self) -> String {
        let recalled = self.source == "recalled";
        let plus = match self.passed {
            Some(p) if recalled => format!(
                "; plus {p} passed by the launcher ({} new)",
                self.added.unwrap_or(p)
            ),
            Some(p) => format!("; plus {p} passed by the launcher"),
            None => String::new(),
        };
        let head = if recalled {
            format!(
                "memory: recalled {} from {}{plus}",
                self.counted(),
                self.why
            )
        } else {
            format!("memory: none — {}{plus}", self.why)
        };
        format!("{head}{}", self.derived_tail())
    }

    fn derived_tail(&self) -> String {
        let Some(n) = self.derived.filter(|n| *n > 0) else {
            return String::new();
        };
        let named = &self.derived_named;
        let list = if named.is_empty() {
            String::new()
        } else {
            format!(": {}", named.join(", "))
        };
        let more = n.saturating_sub(named.len());
        let more = if more > 0 && !named.is_empty() {
            format!(" and {more} more")
        } else {
            String::new()
        };
        format!("; id derived for {n} record(s){list}{more}")
    }

    /// The source with how many of the applied records had their id derived (`withDerived`).
    pub(super) fn with_derived(mut self, applied: &[PriorDecision]) -> Self {
        let derived: Vec<&PriorDecision> = applied.iter().filter(|d| d.derived).collect();
        if derived.is_empty() {
            return self;
        }
        let cut = |t: &str| {
            let units: Vec<u16> = t.encode_utf16().collect();
            match units.get(..DERIVED_TITLE_MAX) {
                Some(head) if units.len() > DERIVED_TITLE_MAX => {
                    format!("{}…", String::from_utf16_lossy(head))
                }
                _ => t.to_owned(),
            }
        };
        self.derived = Some(derived.len());
        self.derived_named = derived
            .iter()
            .take(DERIVED_NAMED_MAX)
            .map(|d| format!("{} ({})", d.id, cut(&d.title)))
            .collect();
        self
    }

    /// As the run record keeps it (`memoryRecord`): the derived ids' titles left out.
    #[must_use]
    pub fn record(&self) -> Value {
        let mut v = serde_json::to_value(self).unwrap_or(Value::Null);
        if let Some(o) = v.as_object_mut() {
            o.remove("derivedNamed");
        }
        v
    }
}
