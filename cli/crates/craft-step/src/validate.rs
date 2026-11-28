//! Whether a submitted answer matches its task's schema; a kind's own checks beyond the schema are
//! its [`crate::Kind::check`], a verifier's batch held to every finding once ([`batch_indices`]).

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

/// Every index `0..count` appears exactly once among the verdicts.
///
/// # Errors
/// The refusal: an index missing, repeated or out of `0..count`.
pub fn batch_indices(answer: &Value, count: usize) -> Result<(), String> {
    let mut seen = vec![false; count];
    let verdicts = answer
        .get("verdicts")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    for v in verdicts {
        let i = v.get("index").and_then(Value::as_u64).unwrap_or(u64::MAX);
        let slot = usize::try_from(i).ok().and_then(|i| seen.get_mut(i));
        match slot {
            Some(s) if !*s => *s = true,
            Some(_) => return Err(format!("verdict index {i} appears twice")),
            None => {
                return Err(format!(
                    "verdict index {i} is not a finding of this batch (0..{count})"
                ));
            }
        }
    }
    match seen.iter().position(|s| !s) {
        Some(i) => Err(format!(
            "no verdict for index {i}: every index 0..{count} must appear"
        )),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::batch_indices;

    fn indices(of: &[u64]) -> serde_json::Value {
        json!({"verdicts": of.iter().map(|i| json!({"index": i})).collect::<Vec<_>>()})
    }

    #[test]
    fn a_batch_answer_names_every_index_once_or_is_refused_saying_which() {
        assert_eq!(batch_indices(&indices(&[1, 0, 2]), 3), Ok(()));
        let why = |of: &[u64]| batch_indices(&indices(of), 3).unwrap_err();
        assert!(why(&[0, 2]).contains("no verdict for index 1"));
        assert!(why(&[0, 1, 1, 2]).contains("index 1 appears twice"));
        assert!(why(&[0, 1, 3]).contains("index 3 is not a finding"));
        assert!(why(&[]).contains("no verdict for index 0"));
        batch_indices(&json!({}), 1).unwrap_err();
        assert_eq!(batch_indices(&json!({}), 0), Ok(()));
    }
}
