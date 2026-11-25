//! The triage's prompts and answer schemas, as `integrations/shared/triage-content.mjs` renders
//! them from `content/prompts/triage-*.md` and `content/schemas/triage-*.schema.json` (realm
//! @nick/craft, nodes #452, #616): the gatherers', each validator's and the plan agent's, and the
//! directive pointing an agent at the triaged repository when one is named.

use craft_review::content::{ContentError, Vars, render, vars};
use craft_store::js::{Js, Obj};
use serde_json::Value;

use crate::field;
use crate::memory::mark;

macro_rules! content {
    ($path:literal) => {
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../content/",
            $path
        ))
    };
}

const GATHER_REPORT: &str = content!("prompts/triage-gather-report.md");
const GATHER_PR: &str = content!("prompts/triage-gather-pr.md");
const VALIDATE: &str = content!("prompts/triage-validate.md");
const VALIDATE_FIX: &str = content!("prompts/triage-validate-fix.md");
const VALIDATE_MEMORY: &str = content!("prompts/triage-validate-memory.md");
const PLAN: &str = content!("prompts/triage-plan.md");
const DEPENDENCY_SOURCE: &str = content!("prompts/dependency-source.md");
const RAW_SCHEMA: &str = content!("schemas/triage-raw.schema.json");
const VALIDATION_SCHEMA: &str = content!("schemas/triage-validation.schema.json");
const PLAN_SCHEMA: &str = content!("schemas/triage-plan.schema.json");

/// An answer schema of the triage's agents.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Schema {
    /// A gatherer's: one source's findings.
    Raw,
    /// A validator's: one verdict on one finding.
    Validation,
    /// The plan agent's: the plan, the ledger, the summary.
    Plan,
}

impl Schema {
    /// The schema as its content file holds it.
    ///
    /// # Errors
    /// When the file is not JSON.
    pub fn value(self) -> Result<Value, ContentError> {
        let (path, text) = match self {
            Self::Raw => ("schemas/triage-raw.schema.json", RAW_SCHEMA),
            Self::Validation => ("schemas/triage-validation.schema.json", VALIDATION_SCHEMA),
            Self::Plan => ("schemas/triage-plan.schema.json", PLAN_SCHEMA),
        };
        serde_json::from_str(text).map_err(|e| ContentError::NotJson(path.into(), e.to_string()))
    }
}

/// The directive pointing an agent at the triaged repository `repo`; '' when none is named, and
/// the agent works where the session does (`repoDirective`).
#[must_use]
pub fn directive(repo: &str) -> String {
    if repo.is_empty() {
        return String::new();
    }
    craft_review::prompts::work_directive(repo, "triage")
}

/// The report gatherer's prompt over the report at `report`.
///
/// # Errors
/// When the template names a value it is not given.
pub fn gather_report(report: &str) -> Result<String, ContentError> {
    render(GATHER_REPORT, &vars([("report", report.to_owned())]))
}

/// The PR gatherer's prompt over PR `pr`.
///
/// # Errors
/// When the template names a value it is not given.
pub fn gather_pr(pr: &str) -> Result<String, ContentError> {
    render(GATHER_PR, &vars([("pr", pr.to_owned())]))
}

/// Where a validator reads the code (`pin`): the ref the findings were generated against, else the
/// tree checked out.
#[must_use]
pub fn pin(base: &str) -> String {
    if base.is_empty() {
        return "Validate against the currently checked-out tree.".into();
    }
    format!(
        "Validate against ref `{base}` (the ref the findings were generated against), not the live working tree."
    )
}

/// What a validator is told beside its finding: its id, the pin, where class 1 is shown, and the
/// memory's note on it.
#[derive(Debug, Clone, Copy)]
pub struct At<'a> {
    pub id: &'a str,
    pub pin: &'a str,
    pub class_one_base: &'a str,
    pub memory_note: &'a str,
}

/// One validator's prompt over the gathered finding `f` (`validatePrompt`): each field as a
/// template literal reads it, the proposed fix and the memory's note on their own lines when given.
///
/// # Errors
/// When a template names a value it is not given.
pub fn validate(f: &Obj, at: &At<'_>) -> Result<String, ContentError> {
    let fix = if field::truthy(f, "proposed_fix") {
        render(
            VALIDATE_FIX,
            &vars([("proposedFix", field::js(f, "proposed_fix"))]),
        )?
    } else {
        String::new()
    };
    let note = mark(&at.memory_note.into()).to_utf8_lossy();
    let memory = if note.is_empty() {
        String::new()
    } else {
        render(VALIDATE_MEMORY, &vars([("memoryNote", note)]))?
    };
    let location = if field::truthy(f, "location") {
        field::js(f, "location")
    } else {
        "(none given)".into()
    };
    let v: Vars = vars([
        ("pin", at.pin.to_owned()),
        ("source", field::js(f, "source")),
        ("severity", field::js(f, "severity")),
        ("location", location),
        ("title", field::js(f, "title")),
        ("detail", field::js(f, "detail")),
        ("proposedFixLine", fix),
        ("memoryNoteLine", memory),
        (
            "dependencySourceHow",
            craft_review::content::content_text(DEPENDENCY_SOURCE).to_owned(),
        ),
        ("classOneBase", at.class_one_base.to_owned()),
        ("stableId", at.id.to_owned()),
    ]);
    render(VALIDATE, &v)
}

/// What the plan agent is handed: the accepted findings, every verdict and the rows settled before
/// validation.
#[derive(Debug, Clone, Copy)]
pub struct Planned<'a> {
    pub accepted: &'a Js,
    pub validations: &'a Js,
    pub sifted: &'a Js,
}

/// The plan agent's prompt (`planPrompt`), each block as `JSON.stringify(v, null, 2)` writes it.
///
/// # Errors
/// When the template names a value it is not given.
pub fn plan(p: &Planned<'_>) -> Result<String, ContentError> {
    render(
        PLAN,
        &vars([
            ("unjudgedMarker", crate::ledger::UNJUDGED_MARKER.to_owned()),
            ("siftMark", crate::sift::SIFT_MARK.to_owned()),
            ("accepted", p.accepted.pretty()),
            ("validations", p.validations.pretty()),
            ("sifted", p.sifted.pretty()),
        ]),
    )
}
