//! A CLI review's record and checkpoints in the store's own format, as `integrations/shared/cli-review-record.mjs`
//! builds them from the finished step the binary printed, read field by field as
//! `integrations/shared/cli-review-step.mjs` reads it (`finishedStep`): each field checked and defaulted the one way.

use crate::js::{Js, JsString, Obj};
use crate::record::{fingerprint, summarize};

const ENGINE: &str = "review";
const DRIVER: &str = "cli";

fn is_obj(v: Option<&Js>) -> Option<&Obj> {
    v.and_then(Js::as_obj)
}

fn text(v: Option<&Js>) -> Js {
    v.filter(|v| v.is_string())
        .cloned()
        .unwrap_or_else(|| Js::str(""))
}

fn strings(v: Option<&Js>) -> Js {
    let a = v.and_then(Js::as_arr).unwrap_or(&[]);
    Js::Arr(a.iter().filter(|x| x.is_string()).cloned().collect())
}

fn objects(v: Option<&Js>) -> Option<Vec<Js>> {
    let a = v?.as_arr()?;
    Some(a.iter().filter(|x| x.as_obj().is_some()).cloned().collect())
}

fn obj_or_null(v: Option<&Js>) -> Js {
    is_obj(v).map_or(Js::Null, |o| Js::Obj(o.clone()))
}

/// `String(v ?? '')`.
fn string_of(v: Option<&Js>) -> Js {
    Js::str(match v {
        None | Some(Js::Null) => JsString::default(),
        Some(v) => v.to_js_text(),
    })
}

/// A whole number, else 0.
fn line_of(v: Option<&Js>) -> Js {
    let n = v
        .and_then(Js::as_num)
        .filter(|n| n.is_finite() && n.fract() == 0.0);
    Js::Num(n.unwrap_or(0.0))
}

/// An absolute path an agent can quote (`absolutePath`): POSIX or a Windows drive path, no control.
fn absolute_path(v: Option<&Js>) -> bool {
    let Some(s) = v.and_then(Js::as_str) else {
        return false;
    };
    let b = s.as_bytes();
    let drive = b.len() >= 3
        && b.first().is_some_and(u8::is_ascii_alphabetic)
        && b.get(1) == Some(&b':')
        && matches!(b.get(2), Some(b'\\' | b'/'));
    (s.starts_with('/') || drive) && !s.chars().any(|c| u32::from(c) < 0x20 || c == '\u{7f}')
}

fn finding(f: &Obj) -> Obj {
    let mut o = Obj::new();
    for k in ["severity", "file"] {
        o.set(k, string_of(f.get(k)));
    }
    o.set("line", line_of(f.get("line")));
    for k in ["title", "ruleId", "tier"] {
        o.set(k, string_of(f.get(k)));
    }
    o
}

fn ledger_row(r: &Obj) -> Obj {
    let mut o = Obj::new();
    o.set("file", text(r.get("file")));
    o.set("line", line_of(r.get("line")));
    for k in ["symbol", "severity", "tier"] {
        o.set(k, text(r.get(k)));
    }
    let disposition = text(r.get("disposition"));
    o.set(
        "disposition",
        if disposition.truthy() {
            disposition
        } else {
            Js::str("open")
        },
    );
    for k in ["source", "ruleId", "title", "why"] {
        o.set(k, text(r.get(k)));
    }
    if text(r.get("toolRule")).truthy() {
        o.set("toolRule", text(r.get("toolRule")));
    }
    if let Some(s) = r.get("sources").filter(|s| s.as_arr().is_some()) {
        o.set("sources", s.clone());
    }
    if let Some(d) = is_obj(r.get("deferral")) {
        o.set("deferral", Js::Obj(d.clone()));
    }
    o
}

/// `{ fp: fingerprint(row), ...row }`.
fn fingerprinted(row: &Obj, key: Option<&Obj>) -> Js {
    let mut o = Obj::new().with("fp", Js::str(fingerprint(key.or(Some(row)))));
    o.spread(row);
    Js::Obj(o)
}

/// The findings going against memory, each fingerprinted over the key the binary names.
fn contradictions_kept(m: Option<&Obj>) -> Js {
    let Some(m) = m else { return Js::Null };
    let items = m.get("findings").and_then(Js::as_arr).unwrap_or(&[]);
    let findings = items
        .iter()
        .map(|i| {
            let mut rest = i.as_obj().cloned().unwrap_or_default();
            let key = rest.remove("key");
            let key = key
                .as_ref()
                .and_then(Js::as_obj)
                .cloned()
                .unwrap_or_default();
            fingerprinted(&rest, Some(&key))
        })
        .collect();
    let mut out = m.clone();
    out.set("findings", Js::Arr(findings));
    Js::Obj(out)
}

/// `publicationKept`: the sorting, the findings going against memory and what was posted.
#[must_use]
pub fn publication_kept(step: &Obj) -> Obj {
    Obj::new()
        .with("sorting", obj_or_null(step.get("sorting")))
        .with(
            "memoryContradictions",
            contradictions_kept(is_obj(step.get("memoryContradictions"))),
        )
        .with("prComments", obj_or_null(step.get("prComments")))
}

/// Why a finished step cannot be read, as `finishedStep` says it; `None` when it can.
#[must_use]
pub fn unreadable_step(step: &Obj) -> Option<&'static str> {
    let verdict = step.get("verdict").filter(|v| v.is_string());
    (!absolute_path(step.get("report")) || verdict.is_none())
        .then_some("a finished step names no report or verdict")
}

/// What a record names beyond the step: who filed it and how.
#[derive(Debug, Clone, Default)]
pub struct At<'a> {
    pub craft_version: &'a str,
    pub depth: &'a str,
    pub strict: bool,
    pub via: Option<&'a str>,
    pub output_tokens: Option<f64>,
    pub runtime: &'a str,
}

fn round_of(step: &Obj) -> Js {
    let n = step.get("round").and_then(Js::as_num);
    let whole = n.filter(|n| n.is_finite() && n.fract() == 0.0 && *n > 0.0);
    Js::Num(whole.unwrap_or(1.0))
}

/// `cliRecord` of the finished `step`, its `runtimeStats` the clock's.
#[must_use]
pub fn cli_record(step: &Obj, stats: Obj, at: &At<'_>) -> Obj {
    let none = Obj::new();
    let findings: Vec<Obj> = objects(step.get("findings"))
        .unwrap_or_default()
        .iter()
        .map(|f| finding(f.as_obj().unwrap_or(&none)))
        .collect();
    let ledger: Vec<Js> = match objects(step.get("ledger")) {
        Some(rows) => rows
            .iter()
            .map(|r| fingerprinted(&ledger_row(r.as_obj().unwrap_or(&none)), None))
            .collect(),
        None => findings.iter().map(finding_row).collect(),
    };
    let lens_scope = if step.get("lensScope").and_then(Js::as_str) == Some("delta") {
        "delta"
    } else {
        "full"
    };
    let runtime = if at.runtime.is_empty() {
        "claude-code"
    } else {
        at.runtime
    };
    let mut r = Obj::new()
        .with("schemaVersion", Js::Num(1.0))
        .with("runtime", Js::str(runtime))
        .with("craftVersion", Js::str(at.craft_version))
        .with("kind", Js::str("workflow"))
        .with("name", Js::str(ENGINE))
        .with("driver", Js::str(DRIVER))
        .with("nested", Js::Bool(at.via.is_some()))
        .with("via", at.via.map_or(Js::Null, Js::str))
        .with("depth", Js::str(at.depth))
        .with("base", text(step.get("base")))
        .with("path", text(step.get("path")))
        .with("verdict", step.get("verdict").cloned().unwrap_or(Js::Null))
        .with("round", round_of(step))
        .with("lensScope", Js::str(lens_scope))
        .with("reReview", obj_or_null(step.get("reReview")));
    let as_js: Vec<Js> = findings.iter().cloned().map(Js::Obj).collect();
    r.set("findings", summarize(&as_js));
    r.set("ledger", Js::Arr(ledger));
    r.set("uncoveredFiles", strings(step.get("uncovered")));
    r.set("notRun", strings(step.get("notRun")));
    r.set(
        "dimensions",
        Js::Arr(objects(step.get("dimensions")).unwrap_or_default()),
    );
    r.set("verification", obj_or_null(step.get("verification")));
    if let Some(rounds) = objects(step.get("lensRounds")) {
        r.set("lensRounds", Js::Arr(rounds));
    }
    r.set("runtimeStats", Js::Obj(stats));
    r.set("memory", obj_or_null(step.get("memory")));
    r.set("strict", Js::Bool(at.strict));
    r.spread(&publication_kept(step));
    r.set("outputTokens", at.output_tokens.map_or(Js::Null, Js::Num));
    r
}

/// A reported finding as a ledger row, none dispositioned.
fn finding_row(f: &Obj) -> Js {
    let mut o = Obj::new().with("fp", Js::str(fingerprint(Some(f))));
    o.set("file", f.get("file").cloned().unwrap_or(Js::Null));
    o.set("line", f.get("line").cloned().unwrap_or(Js::Null));
    o.set("symbol", Js::str(""));
    for k in ["severity", "tier"] {
        o.set(k, f.get(k).cloned().unwrap_or(Js::Null));
    }
    o.set("disposition", Js::str("open"));
    o.set("source", Js::str(""));
    for k in ["ruleId", "title"] {
        o.set(k, f.get(k).cloned().unwrap_or(Js::Null));
    }
    o.set("why", Js::str(""));
    Js::Obj(o)
}

/// `checkpointPayload`: the start's with no figures, a phase's with them.
#[must_use]
pub fn checkpoint_payload(craft_version: &str, phase: &str, figures: &Obj) -> Obj {
    let mut o = Obj::new()
        .with("kind", Js::str("workflow"))
        .with("name", Js::str(ENGINE))
        .with("driver", Js::str(DRIVER))
        .with("craftVersion", Js::str(craft_version))
        .with("phase", Js::str(phase));
    o.spread(figures);
    o
}
