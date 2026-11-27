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
    // status of a held triage says done=false: the stop still wins over every file.
    if status.get("stopped").is_some_and(Value::is_object) {
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
    let again = refile
        .then(|| {
            d.proto
                .submit(
                    run,
                    &Said {
                        resume: true,
                        ..Said::default()
                    },
                )
                .ok()
        })
        .flatten()
        .filter(|s| d.proto.lifecycle().terminal(s));
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
