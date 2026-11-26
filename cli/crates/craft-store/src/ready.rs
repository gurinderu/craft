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
