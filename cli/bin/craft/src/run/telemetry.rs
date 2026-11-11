//! What the run's telemetry writes did, said in the answer (realm @nick/craft, node #40): each
//! write the binary could not land, gathered from the steps' `filing`, and — for a finished run
//! whose record is not in the store — how to file it again. Absence is said, never left to be
//! inferred.

use serde_json::Value;

use super::report::{resume_hint, text};

/// The writes that did not land over the run, each as `<what> — <why>`.
#[derive(Debug, Default)]
pub(crate) struct Lost(pub(crate) Vec<String>);

impl Lost {
    /// Takes the lines the step's telemetry write lost, each logged.
    pub(crate) fn heard(&mut self, step: &Value, log: &dyn Fn(&str)) {
        let lines = step
            .get("filing")
            .and_then(|f| f.get("lost"))
            .and_then(Value::as_array);
        for line in lines.into_iter().flatten().filter_map(Value::as_str) {
            log(&format!("⚠️ telemetry: {line}"));
            self.0.push(line.to_owned());
        }
    }

    /// A write lost for `why`, logged.
    pub(crate) fn note(&mut self, what: &str, why: &str, log: &dyn Fn(&str)) {
        log(&format!("⚠️ telemetry lost: {what} — {why}"));
        self.0.push(format!("{what} — {why}"));
    }

    /// A line of what a write lost, as the filing said it, logged.
    pub(crate) fn note_line(&mut self, line: String, log: &dyn Fn(&str)) {
        log(&format!("⚠️ telemetry lost: {line}"));
        self.0.push(line);
    }

    /// The telemetry section, "" when every write landed.
    pub(crate) fn section(&self) -> String {
        let lines: Vec<&String> = self.0.iter().filter(|l| !l.trim().is_empty()).collect();
        if lines.is_empty() {
            return String::new();
        }
        let landed = lines
            .iter()
            .filter(|l| l.starts_with("the run directory (the record itself landed)"))
            .count();
        let unconfirmed = lines.len() - landed;
        let (title, head) = if unconfirmed > 0 {
            (
                "## ⚠️ Telemetry lost",
                format!(
                    "{unconfirmed} record write(s)/read(s) for this run could not be confirmed, so the run store may be missing or incomplete for it. Read the verdict below — not the store — for what this run actually did."
                ),
            )
        } else {
            let dirs = if landed == 1 {
                "directory"
            } else {
                "directories"
            };
            (
                "## ⚠️ Telemetry incomplete",
                format!(
                    "This run's record is in the store, but {landed} run {dirs} could not be folded into it, so what those held is not there. Read the verdict below for what this run actually did."
                ),
            )
        };
        let mut out = vec![title.to_owned(), head];
        out.extend(lines.iter().map(|l| {
            let flat = l.replace(['\r', '\n'], " ");
            format!("- {}", flat.chars().take(300).collect::<String>())
        }));
        out.push(String::new());
        out.push(String::new());
        out.join("\n")
    }

    /// The notes a finished run's answer carries: the section, and — when the binary did not file
    /// the record — how to file it again.
    pub(crate) fn settled(&mut self, finished: &Value, again: &str, log: &dyn Fn(&str)) -> String {
        let filing = finished.get("filing");
        let record = filing.map(|f| text(f, "record")).unwrap_or_default();
        if record == "filed" {
            return self.section();
        }
        if record != "failed" {
            let why = if filing.is_some() {
                "the craft binary attempted no record"
            } else {
                "the craft binary reported no telemetry write"
            };
            self.note("the run record", why, log);
        }
        let hint = resume_hint(text(finished, "run"), again);
        let how = hint
            .strip_prefix("To resume it once agents can answer again: ")
            .unwrap_or(&hint);
        format!("{}The run record can be filed again: {how}", self.section())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_filed_record_says_nothing_and_a_lost_one_says_how_to_file_it_again() {
        let quiet = |_: &str| {};
        let filed = json!({"run": "/r", "filing": {"record": "filed", "lost": []}});
        assert_eq!(Lost::default().settled(&filed, "again", &quiet), "");
        let failed =
            json!({"run": "/r", "filing": {"record": "failed", "lost": ["the run record — x"]}});
        let mut lost = Lost::default();
        lost.heard(&failed, &quiet);
        let got = lost.settled(&failed, "again", &quiet);
        assert!(
            got.starts_with("## ⚠️ Telemetry lost\n1 record write(s)"),
            "{got}"
        );
        assert!(got.contains("- the run record — x\n\nThe run record can be filed again: again, or the binary `craft review submit --run '/r' --resume`."), "{got}");
        let mut none = Lost::default();
        let got = none.settled(&json!({"run": "/r"}), "again", &quiet);
        assert!(
            got.contains("- the run record — the craft binary reported no telemetry write"),
            "{got}"
        );
    }

    #[test]
    fn a_landed_record_with_a_lost_directory_is_incomplete_not_lost() {
        let lost = Lost(vec![
            "the run directory (the record itself landed) — y".into(),
        ]);
        assert!(lost.section().starts_with(
            "## ⚠️ Telemetry incomplete\nThis run's record is in the store, but 1 run directory"
        ));
    }
}
