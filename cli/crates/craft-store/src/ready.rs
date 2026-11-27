//! A record filed as its run built it — the one write of a run that keeps no checkpoints (triage),
//! as `write` in `integrations/shared/craft-log-run.mjs` files it for that engine (realm @nick/craft,
//! node #616): the fields the writer owns stamped over it, its index line and its proof; an
//! identical `retry` is answered `already filed`.

use crate::adapter::{Env, outcome, writing};
use crate::finalize::{Asked, Said, finalize};
use crate::js::{Js, Obj, Utf16Error};

/// The record `req.record` filed for the repository `req.repo`: `{ ok, reason, file }`.
#[must_use]
pub fn record(req: &Obj, env: &Env) -> Obj {
    filed(req, env).unwrap_or_else(|e| {
        Obj::new()
            .with("ok", Js::Bool(false))
            .with("reason", Js::str(e.to_string()))
    })
}

fn filed(req: &Obj, env: &Env) -> Result<Obj, Utf16Error> {
    req.try_text("repo")?;
    req.try_text("session")?;
    let Some(record) = req.get("record").and_then(Js::as_obj) else {
        return Ok(Obj::new()
            .with("ok", Js::Bool(false))
            .with("reason", Js::str("no record was sent"))
            .with("file", Js::str("")));
    };
    let w = writing(req, env, None)?;
    let asked = Asked {
        retry: req.get("retry") == Some(&Js::Bool(true)),
        ..Asked::default()
    };
    let mut said = Said::default();
    let done = finalize(record, &w, asked, &mut said);
    Ok(outcome(done, &said))
}

#[cfg(test)]
mod tests {
    use super::record;
    use crate::adapter::Env;
    use crate::js::{Js, parse};

    #[test]
    fn an_identical_retry_is_answered_already_filed_and_indexed_once() {
        let (repo, store) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let git = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(repo.path())
            .status()
            .unwrap();
        assert!(git.success());
        let env = Env {
            store: store.path().into(),
            craft_commit: None,
            now: 1_700_000_000_000,
        };
        let req = |retry: bool| {
            let text = format!(
                r#"{{"repo":{repo:?},"session":"s-1","retry":{retry},"record":{{"name":"triage-findings","verdict":"plan"}}}}"#,
                repo = repo.path().display().to_string(),
            );
            parse(&text).unwrap().as_obj().unwrap().clone()
        };
        let first = record(&req(false), &env);
        assert_eq!(first.get("ok"), Some(&Js::Bool(true)), "{first:?}");
        let again = record(&req(true), &env);
        assert_eq!(again.get("ok"), Some(&Js::Bool(true)), "{again:?}");
        let index = std::fs::read_to_string(store.path().join("index.jsonl")).unwrap();
        assert_eq!(index.lines().count(), 1, "indexed once: {index}");
        let filed = first.get("file").and_then(Js::as_str);
        assert!(filed.is_some_and(|f| !f.is_empty()), "{first:?}");
        assert_eq!(
            first.get("file"),
            again.get("file"),
            "the retry names the record filed"
        );
    }
}
