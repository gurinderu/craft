//! An agent that could not look (realm @nick/craft, node #511): a task whose schema carries
//! `blocked` (`content/schemas/blocked.schema.json`) is told to set `blocked.couldNotLook` to true
//! when it could not read the code or run the commands it needs, and an answer that does is a
//! failed task with its reason — never a returned one whose empty findings read as a clean review.
//! The trigger is the literal `true`, not a free string: Codex's strict schema copy makes every
//! optional field required and nullable, and a filler a model writes there ("none", "N/A") must
//! not fail a healthy task. The field is narrow, as the threshold of #24 is: "could not look",
//! never "looked with a simpler tool" — an answer with empty findings and `couldNotLook` false,
//! null or absent stays a clean one.

use serde_json::Value;

use crate::content::{self, ContentError};

/// The answer field an agent that could not look sets.
pub const FIELD: &str = "blocked";

/// The flag inside [`FIELD`] that says so; only the literal `true` counts.
const COULD_NOT_LOOK: &str = "couldNotLook";

/// The line inside [`FIELD`] that says what failed.
const WHAT: &str = "what";

/// The reason of an agent that said it could not look without saying what failed.
const UNSAID: &str = "the agent said it could not look";

/// Why the agent of `answer` could not look, one line; `None` when it did not say so (the flag
/// anything but `true`: false, null, absent, or the field not an object).
#[must_use]
pub fn reason(answer: &Value) -> Option<String> {
    let said = answer.get(FIELD)?;
    if said.get(COULD_NOT_LOOK) != Some(&Value::Bool(true)) {
        return None;
    }
    let line = said
        .get(WHAT)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    Some(if line.is_empty() {
        UNSAID.to_owned()
    } else {
        line
    })
}

/// Why a blocked task failed, as its error says it.
#[must_use]
pub fn failure(reason: &str) -> String {
    format!("could not review: {reason}")
}

/// Whether an answer to `schema` may say it could not look.
#[must_use]
pub(crate) fn asked(schema: &Value) -> bool {
    schema
        .get("properties")
        .and_then(|p| p.get(FIELD))
        .is_some()
}

/// Why the agent of the raw `answer` to `schema` could not look, read before the answer is held
/// to its schema; `None` when the schema does not ask, or it did not say so.
pub(crate) fn said(schema: &Value, answer: &Value) -> Option<String> {
    if !asked(schema) {
        return None;
    }
    reason(&crate::validate::normalize(answer))
}

/// The prompt's note on the field, for a task whose schema carries it; "" otherwise.
///
/// # Errors
/// When the note's content file is missing.
pub(crate) fn note(schema: &Value) -> Result<String, ContentError> {
    if !asked(schema) {
        return Ok(String::new());
    }
    content::text("blocked").map(|t| format!("\n\n{t}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_a_literal_true_blocks() {
        let r = reason(
            &json!({"findings": [], "blocked": {"couldNotLook": true, "what": "  bwrap:\n Operation not permitted "}}),
        );
        assert_eq!(r.as_deref(), Some("bwrap: Operation not permitted"));
        for what in [json!(null), json!("  ")] {
            let r = reason(&json!({"blocked": {"couldNotLook": true, "what": what}}));
            assert_eq!(r.as_deref(), Some(UNSAID), "{what}");
        }
        assert_eq!(
            reason(&json!({"blocked": {"couldNotLook": true}})).as_deref(),
            Some(UNSAID)
        );
        for a in [
            json!({"findings": []}),
            json!({"findings": [], "blocked": null}),
            json!({"findings": [], "blocked": {"couldNotLook": false, "what": "nothing blocked"}}),
            json!({"findings": [], "blocked": {"couldNotLook": null, "what": null}}),
            json!({"findings": [], "blocked": {"couldNotLook": "true"}}),
            json!({"findings": [], "blocked": "none"}),
            json!({"findings": [], "blocked": "bwrap: Operation not permitted"}),
            json!("text"),
        ] {
            assert_eq!(reason(&a), None, "{a}");
        }
    }

    #[test]
    fn the_note_goes_only_to_a_schema_that_carries_the_field() {
        let lens = content::schema("findings").unwrap();
        assert!(
            note(&lens)
                .unwrap()
                .contains("set `blocked.couldNotLook` to true only when")
        );
        let dedup = content::schema("dedup").unwrap();
        assert_eq!(note(&dedup).unwrap(), "");
    }
}
