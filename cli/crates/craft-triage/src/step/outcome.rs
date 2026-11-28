//! The terminal artifact a native host must observe, rather than infer success from `done`.
use crate::TriageError;
use craft_store::js::{self, Js, Obj};
use serde_json::Value;

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Stopped(String),
    Plan {
        complete: bool,
        summary: String,
        notes: Vec<String>,
    },
}

/// Reads the final plan, checking its shape and whether any sources or validations did not run.
/// A stop takes precedence even on a status with `done: false` or stale plan fields.
///
/// # Errors
/// When the plan failed, is missing, unreadable or invalid.
pub fn outcome(step: &Value) -> Result<Outcome, TriageError> {
    if let Some(stop) = step.get("stopped").filter(|s| s.is_object()) {
        return Ok(Outcome::Stopped(
            stop.get("text")
                .and_then(Value::as_str)
                .unwrap_or("stopped by the binary")
                .to_owned(),
        ));
    }
    if let Some(failed) = step.get("failed") {
        return Err(invalid(
            failed
                .as_str()
                .unwrap_or("the Plan-phase agent returned no result"),
        ));
    }
    let path = step
        .get("planFile")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("no planFile"))?;
    let text =
        std::fs::read_to_string(path).map_err(|e| invalid(&format!("cannot read {path}: {e}")))?;
    let plan = js::parse(&text).map_err(|e| invalid(&format!("invalid JSON in {path}: {e}")))?;
    let o = plan
        .as_obj()
        .ok_or_else(|| invalid(plan.as_str().unwrap_or("no plan object")))?;
    let summary = o
        .get("summary")
        .and_then(string)
        .ok_or_else(|| invalid("no summary"))?;
    if !matches!(o.get("plan_markdown"), Some(Js::Str(_))) {
        return Err(invalid("missing plan_markdown"));
    }
    let rows = o
        .get("ledger")
        .and_then(Js::as_arr)
        .ok_or_else(|| invalid("missing ledger"))?;
    if !rows.iter().all(valid_row) {
        return Err(invalid("invalid ledger row"));
    }
    let complete = lines(o, "notRun")?.is_empty();
    let mut notes = lines(o, "memoryDegraded")?;
    if let Some(memory) = o.get("memory").and_then(string) {
        notes.insert(0, memory);
    }
    Ok(Outcome::Plan {
        complete,
        summary,
        notes,
    })
}

fn invalid(why: &str) -> TriageError {
    TriageError::Answer {
        what: "the final triage plan".into(),
        why: why.into(),
    }
}

fn valid_row(row: &Js) -> bool {
    row.as_obj().is_some_and(|o| {
        ["stable_id", "verdict", "reason"]
            .iter()
            .all(|key| matches!(o.get(key), Some(Js::Str(_))))
    })
}

fn lines(o: &Obj, key: &str) -> Result<Vec<String>, TriageError> {
    let Some(value) = o.get(key) else {
        return Ok(Vec::new());
    };
    let list = value
        .as_arr()
        .ok_or_else(|| invalid(&format!("{key} is not a list")))?;
    list.iter()
        .map(|v| string(v).ok_or_else(|| invalid(&format!("invalid {key} line"))))
        .collect()
}

fn string(v: &Js) -> Option<String> {
    if let Js::Str(s) = v {
        Some(s.to_utf8_lossy())
    } else {
        None
    }
}

#[cfg(test)]
#[path = "outcome_tests.rs"]
mod tests;
