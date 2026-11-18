//! What a step command prints for its host, kept small enough for a service agent to copy whole
//! (realm @nick/craft, node #522): a finished step and the status's `filing.finished` leave out
//! the chain's `ledger`. The host reads no ledger from them; the run's record is filed with it by
//! the binary itself, from the step in hand, and a re-file reads it from the run's `filing.json`.

use std::io::Write;

use serde_json::Value;

/// `value` written to `out` as one JSON line, as the host is handed it ([`for_host`]): what every
/// step command prints.
pub(crate) fn write_line(out: &mut impl Write, value: &Value) -> anyhow::Result<()> {
    writeln!(out, "{}", serde_json::to_string(&for_host(value.clone()))?)?;
    Ok(())
}

/// `value` as the host is handed it: without the ledger of a finished step, its own or the one
/// the status names under `filing.finished`.
pub(crate) fn for_host(mut value: Value) -> Value {
    if let Some(finished) = value
        .pointer_mut("/filing/finished")
        .and_then(Value::as_object_mut)
    {
        finished.remove("ledger");
    }
    if let Some(step) = value
        .as_object_mut()
        .filter(|s| s.get("done") == Some(&Value::Bool(true)))
    {
        step.remove("ledger");
    }
    value
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{for_host, write_line};

    #[test]
    fn a_printed_step_is_the_one_for_the_host() {
        let done = json!({"run": "/r", "done": true, "verdict": "Block", "ledger": [{"title": "x"}],
            "filing": {"finished": {"done": true, "ledger": [{"title": "x"}]}}});
        let mut out = Vec::new();
        write_line(&mut out, &done).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.ends_with('\n') && text.lines().count() == 1, "{text}");
        let printed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(printed, for_host(done));
        assert!(!text.contains("ledger"), "{text}");
    }

    #[test]
    fn a_finished_step_is_printed_without_its_ledger() {
        let done = json!({"run": "/r", "done": true, "verdict": "Block", "round": 2, "findings": [1], "ledger": [{"title": "x"}]});
        let printed = for_host(done);
        assert!(printed.get("ledger").is_none(), "{printed}");
        assert_eq!(printed["findings"], json!([1]));
        assert_eq!(printed["round"], json!(2));
    }

    #[test]
    fn the_status_names_its_finished_step_without_its_ledger() {
        let status = json!({"run": "/r", "done": true, "verdict": "Block",
            "filing": {"record": "filed", "finished": {"done": true, "verdict": "Block", "ledger": [{"title": "x"}]}}});
        let printed = for_host(status);
        assert!(
            printed["filing"]["finished"].get("ledger").is_none(),
            "{printed}"
        );
        assert_eq!(printed["filing"]["finished"]["verdict"], json!("Block"));
        assert_eq!(printed["filing"]["record"], json!("filed"));
    }

    #[test]
    fn a_pending_step_is_printed_as_it_is() {
        let pending = json!({"run": "/r", "done": false, "tasks": [], "ledger": "kept"});
        assert_eq!(for_host(pending.clone()), pending);
    }
}
