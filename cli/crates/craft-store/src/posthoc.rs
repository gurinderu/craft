//! The writes made after a run, from the binary (`craft runs sorting-choice | develop-cycle`), as
//! requests answered `{ ok, reason, file }` — the shape `content/parity/posthoc-store-cases.json`
//! holds them to: what the JavaScript writer's `sorting-choice` and `develop-cycle` verbs filed,
//! frozen when they were removed.

use std::path::{Path, PathBuf};

use crate::adapter::{Env, writing};
use crate::js::{Js, Obj};

/// How a write ended: its file and what it said, or why it did not land.
pub type Said = Result<(PathBuf, String, Vec<String>), String>;

fn answer(said: Said) -> Obj {
    let (ok, reason, file) = match said {
        Ok((file, line, _)) => (true, line, file.display().to_string()),
        Err(why) => (false, format!("craft-log-run FAILED: {why}"), String::new()),
    };
    Obj::new()
        .with("ok", Js::Bool(ok))
        .with("reason", Js::str(reason))
        .with("file", Js::str(file))
}

/// One craft:develop cycle (`cycle`) filed as a record of the repository at `repo`.
///
/// # Errors
/// When the cycle does not fit, or the write does not land.
pub fn develop_cycle(cycle: &Obj, req: &Obj, env: &Env) -> Said {
    let record = crate::develop::cycle_record(cycle)?;
    let w = writing(req, env, None).map_err(|e| e.to_string())?;
    let (file, _) =
        crate::write::write_record(&record, &w, &w.git_id, None).map_err(|e| e.to_string())?;
    Ok((
        file.clone(),
        format!("wrote {}", file.display()),
        Vec::new(),
    ))
}

/// The reviewer's `choice` for doubtful finding `n`, into `record` or, when none is named, the
/// newest review record of the repository's branch carrying doubtful findings.
///
/// # Errors
/// When no record is found or named, or the choice cannot be recorded.
pub fn sorting_choice(n: f64, choice: &str, record: Option<&Path>, req: &Obj, env: &Env) -> Said {
    if !(n.is_finite() && n.fract() == 0.0 && n >= 1.0) || choice.is_empty() {
        return Err(
            "usage: sorting-choice --n <n> --choice <question|defect|dropped> [--record <f>]"
                .into(),
        );
    }
    let file = sorted_record(record, req, env)?;
    let (line, warned) = crate::sorting::record_choice(&env.store, &file, n, choice, env.now)?;
    Ok((file, line, warned))
}

/// The review record holding the doubtful findings: `record` when named, else the newest of the
/// repository's branch carrying them.
///
/// # Errors
/// When none is named or found, or the newest is another branch's.
pub fn sorted_record(record: Option<&Path>, req: &Obj, env: &Env) -> Result<PathBuf, String> {
    if let Some(f) = record {
        return Ok(f.to_path_buf());
    }
    let w = writing(req, env, None).map_err(|e| e.to_string())?;
    crate::sorting::latest_sorted_record(&env.store, &w.project, &w.git_id.branch)
}

/// A request's answer, for the parity cases.
pub(crate) fn answer_request(command: &str, req: &Obj, env: &Env) -> Option<Obj> {
    let said = match command {
        "develop-cycle" => {
            let none = Obj::new();
            let cycle = req.get("cycle").and_then(Js::as_obj).unwrap_or(&none);
            develop_cycle(cycle, req, env)
        }
        "sorting-choice" => {
            let n = crate::publication::js_number(req.get("n"));
            let record = req.text_units("recordFile").to_utf8().unwrap_or_default();
            let record = (!record.is_empty()).then(|| PathBuf::from(record));
            let choice = req.text_units("choice").to_utf8().unwrap_or_default();
            sorting_choice(n, &choice, record.as_deref(), req, env)
        }
        _ => return None,
    };
    Some(answer(said))
}
