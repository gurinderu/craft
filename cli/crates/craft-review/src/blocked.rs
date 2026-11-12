//! An agent that could not look (realm @nick/craft, node #511): a task whose schema carries
//! `blocked` (`content/schemas/blocked.schema.json`) is told to set it when it could not read the
//! code or run the commands it needs, and an answer that sets it is a failed task with that reason
//! — never a returned one whose empty findings read as a clean review. The field is narrow, as the
//! threshold of #24 is: "could not look", never "looked with a simpler tool" — an answer with empty
//! findings and no `blocked` stays a clean one.

use serde_json::Value;

use crate::content::{self, ContentError};

/// The answer field an agent that could not look sets.
pub const FIELD: &str = "blocked";

/// Why the agent of `answer` could not look, one line; `None` when it did not say so (the field
/// absent, null, or blank).
#[must_use]
pub fn reason(answer: &Value) -> Option<String> {
    let said = answer.get(FIELD)?.as_str()?;
    let line = said.split_whitespace().collect::<Vec<_>>().join(" ");
    (!line.is_empty()).then_some(line)
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
    fn only_a_said_reason_blocks() {
        let r = reason(&json!({"findings": [], "blocked": "  bwrap:\n Operation not permitted "}));
        assert_eq!(r.as_deref(), Some("bwrap: Operation not permitted"));
        for a in [
            json!({"findings": []}),
            json!({"findings": [], "blocked": null}),
            json!({"findings": [], "blocked": "  "}),
            json!("text"),
        ] {
            assert_eq!(reason(&a), None, "{a}");
        }
    }

    #[test]
    fn the_note_goes_only_to_a_schema_that_carries_the_field() {
        let lens = content::schema("findings").unwrap();
        assert!(note(&lens).unwrap().contains("set `blocked` to one line"));
        let dedup = content::schema("dedup").unwrap();
        assert_eq!(note(&dedup).unwrap(), "");
    }
}
