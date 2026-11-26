//! The binary's three writes, answered as the JavaScript adapter answered them (kept as
//! `integrations/shared/binary-filing-replay.mjs`, the parity cases' source) over
//! `integrations/shared/craft-log-run.mjs` (realm @nick/craft, nodes #456, #539): a checkpoint's `{ phase, runDir }`
//! or `{ phase, error }`, or `{ skipped: true }` when no phase ended; the record's `{ ok, reason,
//! file }`; a publication's `{ ok, reason, file }`. The request is the JSON object the binary
//! builds (`craft-review`'s `filing/wire.rs`).

use std::path::{Path, PathBuf};

use crate::checkpoint::{Identity, checkpoint_dir, inside_store, write_checkpoint};
use crate::cli_record::{At, checkpoint_payload, cli_record, unreadable_step};
use crate::finalize::{Asked, Said, finalize};
use crate::git::{GitId, identity, repo_key, short_commit};
use crate::js::{Js, Obj, Utf16Error};
use crate::write::{Writing, with_git};

/// Where and when the writes land, and the craft that writes them.
#[derive(Debug, Clone)]
pub struct Env {
    pub store: PathBuf,
    /// The writing craft's commit (`craftCommit`), `None` outside a checkout.
    pub craft_commit: Option<String>,
    /// Milliseconds since the epoch.
    pub now: i64,
}

/// The run's identity as the binary kept it when it started, for a re-file or a write after the
/// working copy is gone: the git directory it is keyed through and the fields it stamps.
pub(crate) struct Kept {
    git_dir: String,
    fields: Obj,
}

fn kept_identity(req: &Obj, refile: bool) -> Result<Option<Kept>, Utf16Error> {
    let (git_dir, repo) = (req.text("gitDir")?, req.text("repo")?);
    let gone = repo.is_empty() || !Path::new(repo).exists();
    if git_dir.is_empty() || !Path::new(git_dir).exists() || !(refile || gone) {
        return Ok(None);
    }
    let mut fields = Obj::new();
    if !req.text("branch")?.is_empty() {
        fields.set("branch", Js::str(req.text("branch")?));
    }
    let head = req.text("head")?;
    if !head.is_empty() {
        fields.set("head", Js::str(head));
        fields.set("commit", Js::str(short_commit(Path::new(git_dir), head)));
    }
    fields.set("dirty", Js::Bool(req.get("dirty") == Some(&Js::Bool(true))));
    Ok(Some(Kept {
        git_dir: git_dir.to_owned(),
        fields,
    }))
}

/// What the logger's flags made of the request: the repository keyed through the kept git
/// directory when there is one, else the reviewed one.
pub(crate) fn writing(req: &Obj, env: &Env, kept: Option<&Kept>) -> Result<Writing, Utf16Error> {
    let repo = req.text("repo")?;
    let cwd = if repo.is_empty() {
        std::env::current_dir().unwrap_or_default()
    } else {
        PathBuf::from(repo)
    };
    let named = kept.map_or(repo, |k| k.git_dir.as_str());
    let workdir = crate::git::lexical(&cwd.join(named));
    let from_record = kept.is_some();
    Ok(Writing {
        store: env.store.clone(),
        project: repo_key(&workdir).display().to_string(),
        git_id: if from_record {
            GitId::default()
        } else {
            identity(&workdir)
        },
        workdir,
        session: req.text("session")?.to_owned(),
        observe: !from_record,
        craft_commit: env.craft_commit.clone(),
        now: env.now,
    })
}

fn steps(req: &Obj) -> &[Js] {
    req.get("steps").and_then(Js::as_arr).unwrap_or(&[])
}

/// The start's checkpoint, or the one of the phase the last step ended.
#[must_use]
pub fn checkpoint(req: &Obj, env: &Env) -> Obj {
    checkpoint_inner(req, env).unwrap_or_else(|e| Obj::new().with("error", Js::str(e.to_string())))
}

fn checkpoint_inner(req: &Obj, env: &Env) -> Result<Obj, Utf16Error> {
    request_text(req)?;
    let start = req.get("start") == Some(&Js::Bool(true));
    let ended = if start {
        None
    } else {
        match crate::clock::replay(steps(req)) {
            Ok((Some(e), _)) => Some(e),
            Ok((None, _)) => return Ok(Obj::new().with("skipped", Js::Bool(true))),
            Err(e) => return Err(e),
        }
    };
    let cv = req.text("craftVersion")?;
    let (phase, payload) = match &ended {
        Some(e) => {
            let figures = Obj::new()
                .with("minutes", e.minutes.map_or(Js::Null, Js::Num))
                .with("agents", Js::Num(e.agents))
                .with("head", Js::str(req.text("head")?));
            (e.phase.clone(), checkpoint_payload(cv, &e.phase, &figures))
        }
        None => (
            "start".to_owned(),
            checkpoint_payload(cv, "start", &Obj::new()),
        ),
    };
    let kept = kept_identity(req, false)?;
    let mut payload = payload;
    if !req.text("runtime")?.is_empty() {
        payload.set("runtime", Js::str(req.text("runtime")?));
    }
    if let Some(k) = &kept {
        payload.set(
            "branch",
            k.fields.get("branch").cloned().unwrap_or(Js::str("")),
        );
        payload.set("head", k.fields.get("head").cloned().unwrap_or(Js::str("")));
    }
    let w = writing(req, env, kept.as_ref())?;
    let answer = Obj::new().with("phase", Js::str(&phase));
    let mut warned = Vec::new();
    Ok(match write_slice(req, &w, &phase, &payload, &mut warned) {
        Ok(dir) => answer.with("runDir", Js::str(dir.display().to_string())),
        Err(e) => {
            warned.push(format!("craft-log-run FAILED: {e}"));
            answer.with("error", Js::str(warned.join("; ")))
        }
    })
}

fn write_slice(
    req: &Obj,
    w: &Writing,
    phase: &str,
    payload: &Obj,
    warned: &mut Vec<String>,
) -> Result<PathBuf, crate::StoreError> {
    let payload = with_git(payload, &w.git_id);
    let asked = req.text("dir")?;
    let asked = (!asked.is_empty())
        .then(|| resolve(req, asked))
        .transpose()?;
    let refused = asked
        .as_ref()
        .filter(|a| !inside_store(&a.display().to_string(), &w.store))
        .cloned();
    if let Some(r) = &refused {
        warned.push(format!(
            "craft-log-run WARNING: --dir {} is not inside {} — a fresh run directory was used instead",
            crate::finalize::safe_path(&r.display().to_string()),
            w.store.join(".partial").display()
        ));
    }
    let dir = if let Some(d) = asked.filter(|_| refused.is_none()) {
        d
    } else {
        let mut want = Identity::of(&payload);
        want.project = w.project.clone().into();
        let rejoin = req.get("rejoin") == Some(&Js::Bool(true));
        checkpoint_dir(&payload, &w.store, &want, rejoin, w.now)?
    };
    write_checkpoint(&dir, phase, &payload, (&w.project, &w.session), w.now)?;
    Ok(dir)
}

/// A path the request names, resolved against the reviewed repository as the logger's cwd.
fn resolve(req: &Obj, p: &str) -> Result<PathBuf, Utf16Error> {
    let base = PathBuf::from(req.text("repo")?);
    Ok(crate::git::lexical(
        &std::path::absolute(base.join(p)).unwrap_or_else(|_| PathBuf::from(p)),
    ))
}

/// The record of the finished step.
#[must_use]
pub fn record(req: &Obj, env: &Env) -> Obj {
    record_inner(req, env).unwrap_or_else(|e| {
        Obj::new()
            .with("ok", Js::Bool(false))
            .with("reason", Js::str(e.to_string()))
    })
}

fn record_inner(req: &Obj, env: &Env) -> Result<Obj, Utf16Error> {
    request_text(req)?;
    let none = Obj::new();
    let step = req.get("step").and_then(Js::as_obj).unwrap_or(&none);
    if let Some(why) = unreadable_step(step) {
        return Ok(Obj::new().with("ok", Js::Bool(false)).with(
            "reason",
            Js::str(format!("the finished step cannot be read: {why}")),
        ));
    }
    let depth = req.text("depth")?;
    let via = req.text("via")?;
    let at = At {
        craft_version: req.text("craftVersion")?,
        depth: if depth.is_empty() { "full" } else { depth },
        strict: req.get("strict") == Some(&Js::Bool(true)),
        via: (!via.is_empty()).then_some(via),
        output_tokens: req.get("outputTokens").and_then(Js::as_num),
        output_tokens_scope: req.text("outputTokensScope")?,
        runtime: req.text("runtime")?,
    };
    let retry = req.get("retry") == Some(&Js::Bool(true));
    let kept = kept_identity(req, retry)?;
    let stats = match crate::clock::replay(steps(req)) {
        Ok((_, stats)) => stats,
        Err(e) => return Err(e),
    };
    let first = cli_record(step, stats, &at);
    let mut rec = first.clone();
    if let Some(k) = &kept {
        rec.spread(&k.fields);
    }
    let w = writing(req, env, kept.as_ref())?;
    let dir = req.text("dir")?;
    let dir = if dir.is_empty() {
        String::new()
    } else {
        resolve(req, dir)?.display().to_string()
    };
    let asked = Asked {
        dir: &dir,
        rejoin: req.get("rejoin") == Some(&Js::Bool(true)),
        retry,
        first: (retry && kept.is_some()).then_some(&first),
    };
    let mut said = Said::default();
    let done = finalize(&rec, &w, asked, &mut said);
    Ok(outcome(done, &said))
}

fn request_text(req: &Obj) -> Result<(), crate::js::Utf16Error> {
    for key in [
        "gitDir",
        "repo",
        "branch",
        "head",
        "session",
        "craftVersion",
        "runtime",
        "dir",
        "depth",
        "via",
        "outputTokensScope",
    ] {
        req.try_text(key)?;
    }
    Ok(())
}

/// `logRunOutcome` over what the finalize said, with the file it filed.
pub(crate) fn outcome(done: Result<(), crate::StoreError>, said: &Said) -> Obj {
    let file = said
        .out
        .iter()
        .filter_map(|l| {
            l.strip_prefix("wrote ")
                .or_else(|| l.strip_prefix("already filed "))
        })
        .filter_map(|l| l.split(" (").next())
        .rfind(|f| f.starts_with('/') && f.ends_with(".json"))
        .unwrap_or("")
        .to_owned();
    match done {
        Ok(()) => {
            let warned: Vec<&str> = said
                .err
                .iter()
                .filter(|l| l.starts_with("craft-log-run WARNING:"))
                .map(String::as_str)
                .collect();
            Obj::new()
                .with("ok", Js::Bool(true))
                .with("reason", Js::str(warned.join("; ")))
                .with("file", Js::str(file))
        }
        Err(e) => Obj::new()
            .with("ok", Js::Bool(false))
            .with("reason", Js::str(format!("craft-log-run FAILED: {e}")))
            .with("file", Js::str(file)),
    }
}
