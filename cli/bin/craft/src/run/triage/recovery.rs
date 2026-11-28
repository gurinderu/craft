//! Recover the authoritative triage terminal state after a lost in-process response.
use std::path::Path;

use serde_json::Value;

use crate::run::drive::{Driver, Running, is_done};
use crate::run::ending::Ending;
use crate::run::protocol::{Protocol, Said};
use crate::run::report::text;

pub(crate) fn recovered<P: Protocol>(
    d: &Driver<'_, P>,
    run: &Path,
    error: &str,
    r: &mut Running,
) -> Ending {
    let status = match d.proto.status(run) {
        Ok(s) => s,
        Err(e) => return unavailable(error, &format!("status unavailable: {e:#}"), r),
    };
    // status of a held triage says done=false: the stop still wins over every file. The stop on
    // disk need not explain the step that failed, so that failure is named beside it.
    if status.get("stopped").is_some_and(Value::is_object) {
        r.lost.note("the step after the stop", error, &|l| d.log(l));
        return Ending::Finished(status);
    }
    if !is_done(&status) {
        return unavailable(
            error,
            &format!("the binary reports phase {}", text(&status, "phase")),
            r,
        );
    }
    let refile = status
        .get("filing")
        .is_some_and(|f| text(f, "record") != "filed");
    let again = if refile {
        r.lost.note("the lost step", error, &|l| d.log(l));
        let said = Said {
            resume: true,
            ..Said::default()
        };
        match d.proto.submit(run, &said) {
            Ok(s) if d.proto.lifecycle().terminal(&s) => Some(s),
            Ok(_) => None,
            Err(e) => {
                r.lost
                    .note("the record's refiling", &format!("{e:#}"), &|l| d.log(l));
                None
            }
        }
    } else {
        None
    };
    let last = again.unwrap_or(status);
    r.lost.heard(&last, &|l| d.log(l));
    Ending::Finished(last)
}

fn unavailable(error: &str, state: &str, r: &Running) -> Ending {
    let reason = r.limit.as_ref().map_or_else(
        || error.to_owned(),
        |l| format!("usage limit reached: {l}; {error}"),
    );
    Ending::Unrecorded(format!(
        "{reason}; {state}. The triage's completion could not be established; no fallback record was filed"
    ))
}
