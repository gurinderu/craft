//! The deletion/recovery-path floor (`lib/path-severity-floor.mjs`): a catalogue lens's finding on
//! a deletion or recovery path, below Medium, naming a harm of operator recovery or worse, is
//! raised to Medium before verification, with a note saying so.

use serde_json::{Map, Value};

use super::{effective_level, level_rank, text};

/// The lenses whose flag the floor honours: those that read the distributed-races catalogue.
const PATH_FLOOR_LENSES: [&str; 2] = ["reconciler", "failure-windows"];
const NOTE_HEAD: &str = " (raised to Medium from ";
const NOTE_MARK: &str = ": deletion/recovery-path floor (R16-R20 catalogue); ";

/// `f` raised to Medium when the floor holds for it, else `f` unchanged.
pub(crate) fn raise_path_floor(f: &Value) -> Value {
    let severity = text(f, "severity").unwrap_or("");
    let holds = f.get("deletionOrRecoveryPath") == Some(&Value::Bool(true))
        && PATH_FLOOR_LENSES.contains(&text(f, "source").unwrap_or(""))
        && matches!(severity, "Low" | "Info")
        && effective_level(f).is_some_and(|l| level_rank(l) <= level_rank("operator-recovery"));
    if !holds {
        return f.clone();
    }
    let mut out: Map<String, Value> = f.as_object().cloned().unwrap_or_default();
    let why = format!(
        "{}{NOTE_HEAD}{severity}{NOTE_MARK}a verifier judging it unreachable in production can still lower it)",
        text(f, "why").unwrap_or("")
    );
    out.insert("severity".into(), Value::String("Medium".into()));
    out.insert("why".into(), Value::String(why));
    Value::Object(out)
}

/// The floor's note in `why`, or `""` when the floor did not raise it.
pub(crate) fn floor_note(why: &str) -> &str {
    let mut from = 0;
    while let Some(at) = why
        .get(from..)
        .and_then(|s| s.find(NOTE_HEAD))
        .map(|i| i + from)
    {
        let after = at + NOTE_HEAD.len();
        let rest = why.get(after..).unwrap_or("");
        let word = rest
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .unwrap_or(rest.len());
        let tail = rest.get(word..).unwrap_or("");
        if word > 0 && tail.starts_with(NOTE_MARK) {
            let close = tail.get(NOTE_MARK.len()..).and_then(|t| t.find(')'));
            if let Some(c) = close {
                let end = after + word + NOTE_MARK.len() + c + 1;
                return why.get(at..end).unwrap_or("");
            }
        }
        from = after;
    }
    ""
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_floor_raises_a_flagged_catalogue_finding_and_its_note_is_found_again() {
        let f = json!({"severity": "Low", "source": "reconciler", "why": "w", "deletionOrRecoveryPath": true, "harmLevel": "operator-recovery"});
        let up = raise_path_floor(&f);
        assert_eq!(up["severity"], "Medium");
        let why = up["why"].as_str().unwrap();
        assert_eq!(floor_note(why), why.strip_prefix('w').unwrap());
        assert_eq!(floor_note("no note here"), "");
        for unmoved in [
            json!({"severity": "Low", "source": "errors", "deletionOrRecoveryPath": true, "harmLevel": "outage"}),
            json!({"severity": "Low", "source": "reconciler", "deletionOrRecoveryPath": true, "harmLevel": "self-healing"}),
            json!({"severity": "High", "source": "reconciler", "deletionOrRecoveryPath": true, "harmLevel": "outage"}),
        ] {
            assert_eq!(raise_path_floor(&unmoved), unmoved);
        }
    }
}
