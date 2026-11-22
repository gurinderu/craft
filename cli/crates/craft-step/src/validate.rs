//! Whether a submitted answer matches its task's schema; a kind's own checks beyond the schema are
//! its [`crate::Kind::check`].

use serde_json::Value;

/// How many schema errors a refusal names.
const ERRORS_SHOWN: usize = 3;

/// `answer` as JSON: a string that parses as JSON is that JSON (an agent's final text), any other
/// string stays text.
#[must_use]
pub fn normalize(answer: &Value) -> Value {
    match answer {
        Value::String(s) => serde_json::from_str(s.trim()).unwrap_or_else(|_| answer.clone()),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::Array(_) | Value::Object(_) => {
            answer.clone()
        }
    }
}

/// The `answer` as JSON when it matches `schema`, or why not, in one line.
///
/// # Errors
/// The refusal: no answer, or a schema mismatch naming its first errors.
pub fn check(schema: &Value, answer: Option<&Value>) -> Result<Value, String> {
    let answer = normalize(answer.ok_or("no answer was submitted")?);
    let validator = jsonschema::validator_for(schema)
        .map_err(|e| format!("the task's own schema does not compile: {e}"))?;
    let errors: Vec<String> = validator
        .iter_errors(&answer)
        .take(ERRORS_SHOWN)
        .map(|e| {
            let at = e.instance_path().to_string();
            let at = if at.is_empty() { "/".to_owned() } else { at };
            format!("at {at}: {e}")
        })
        .collect();
    if !errors.is_empty() {
        return Err(format!(
            "it does not match the schema ({})",
            errors.join("; ")
        ));
    }
    Ok(answer)
}
