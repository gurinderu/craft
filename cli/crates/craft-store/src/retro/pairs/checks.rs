//! Why a pair of consecutive review rounds can differ for another reason than memory, each a
//! condition the pair fails, tested in order; a pair failing none is `clean` (realm @nick/craft,
//! nodes #97, #18, #357, #393).

use crate::cost::problem::{Problem, problem};
use crate::js::{Js, JsString, Obj};

fn get<'a>(r: &'a Obj, k: &str) -> Option<&'a Js> {
    r.get(k)
}

fn sub<'a>(r: &'a Obj, k: &str, f: &str) -> Option<&'a Js> {
    r.get(k).and_then(Js::as_obj).and_then(|o| o.get(f))
}

fn truthy(v: Option<&Js>) -> bool {
    v.is_some_and(Js::truthy)
}

fn integer(v: Option<&Js>) -> Option<f64> {
    v.and_then(Js::as_num)
        .filter(|n| n.is_finite() && n.fract() == 0.0)
}

fn attributed(r: &Obj) -> bool {
    integer(get(r, "workflowEngineRevision"))
        .or_else(|| integer(get(r, "engineRevision")))
        .is_some()
}

fn list(v: Option<&Js>) -> &[Js] {
    v.and_then(Js::as_arr).unwrap_or(&[])
}

/// `arr(xs).map(String).sort().join(',')`.
fn sorted(v: Option<&Js>) -> JsString {
    let mut items: Vec<JsString> = list(v).iter().map(Js::to_js_text).collect();
    items.sort();
    JsString::join(&items, ",")
}

/// What the run was asked to do, as one text: a different configuration moves the cost by itself.
fn config(r: &Obj) -> String {
    let mut scout: Vec<JsString> = list(get(r, "scout"))
        .iter()
        .map(|s| {
            let o = s.as_obj();
            let field = |k: &str| o.and_then(|o| o.get(k)).cloned().unwrap_or(Js::Null);
            let parts = [
                field("language"),
                Js::Str(sorted(o.and_then(|o| o.get("lenses")))),
                field("model"),
                field("maxRounds"),
                field("verifyVotes"),
                field("size"),
                field("securitySensitive"),
                field("isLibrary"),
            ];
            JsString::join(
                &parts
                    .iter()
                    .map(|p| {
                        if *p == Js::Null {
                            JsString::default()
                        } else {
                            p.to_js_text()
                        }
                    })
                    .collect::<Vec<_>>(),
                ":",
            )
        })
        .collect();
    scout.sort();
    let or_null = |k: &str| get(r, k).cloned().unwrap_or(Js::Null);
    let optional = get(r, "optionalPass")
        .and_then(Js::as_obj)
        .and_then(|o| o.get("requested"));
    let depth = if r.text_units("depth") == "light" {
        "light"
    } else {
        "full"
    };
    Js::Arr(vec![
        Js::Str(sorted(get(r, "languages"))),
        Js::Arr(scout.into_iter().map(Js::Str).collect()),
        Js::Str(sorted(get(r, "criticFollowups"))),
        Js::Str(sorted(optional)),
        Js::Bool(truthy(get(r, "strict"))),
        or_null("intentDigest"),
        or_null("specDigest"),
        Js::str(depth),
    ])
    .compact()
}

fn incomplete(r: &Obj) -> bool {
    let not_run = get(r, "notRun").and_then(Js::as_arr);
    let verdict = get(r, "verdict")
        .map_or_else(|| "undefined".into(), Js::to_js_text)
        .map_unicode(str::to_uppercase);
    not_run.is_none_or(|n| !n.is_empty())
        || sub(r, "gate", "status").and_then(Js::as_str) != Some("pass")
        || get(r, "verification").is_none_or(|v| *v == Js::Null)
        || verdict.contains("INCOMPLETE")
        || verdict.contains("PARTIAL COVERAGE")
}

fn memory_intact(r: &Obj) -> bool {
    let rr = |k: &str| sub(r, "reReview", k);
    truthy(get(r, "reReview"))
        && rr("chained") == Some(&Js::Bool(true))
        && rr("ledgerDegraded") == Some(&Js::Bool(false))
        && rr("journalSourced") == Some(&Js::Bool(false))
        && rr("fpComparable") != Some(&Js::Bool(false))
        && rr("basisMismatch") != Some(&Js::Bool(true))
        && rr("tombstonesDropped")
            .is_none_or(|v| v.to_js_number().partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater))
}

fn chained_to(a: &Obj, b: &Obj) -> bool {
    let rr = |k: &str| sub(b, "reReview", k);
    rr("priorRound").is_some()
        && rr("priorRound") == get(a, "round")
        && truthy(rr("priorHead"))
        && rr("priorHead") == get(a, "head")
}

fn same_diff(a: &Obj, b: &Obj) -> bool {
    let path = |r: &Obj| {
        get(r, "path")
            .filter(|v| v.truthy())
            .cloned()
            .unwrap_or_else(|| Js::str(""))
    };
    truthy(get(a, "head"))
        && get(a, "head") == get(b, "head")
        && get(a, "base").is_some_and(Js::is_string)
        && get(a, "base") == get(b, "base")
        && path(a) == path(b)
        && truthy(get(a, "filesDigest"))
        && get(a, "filesDigest") == get(b, "filesDigest")
}

fn count_bad(v: Option<&Js>) -> bool {
    v.is_some_and(|v| *v != Js::Null && v.as_num().is_none_or(|n| !n.is_finite() || n < 0.0))
}

fn bad_count(r: &Obj) -> bool {
    let total = sub(r, "findings", "total")
        .filter(|v| **v != Js::Null)
        .or_else(|| get(r, "findingsTotal"));
    count_bad(sub(r, "verification", "candidates"))
        || count_bad(total)
        || list(get(r, "lensRounds"))
            .iter()
            .any(|x| count_bad(x.as_obj().and_then(|o| o.get("agents"))))
}

/// A cost's slice of one run's records: its index and how many.
fn slice(c: &Obj) -> Option<(f64, f64)> {
    let s = c.get("slice").and_then(Js::as_obj)?;
    let whole = |k: &str| integer(s.get(k)).filter(|n| *n >= 0.0);
    let (index, of) = (whole("index")?, whole("of")?);
    let tail = s
        .get("tail")
        .is_none_or(|t| *t == Js::Null || whole("tail").is_some());
    (index >= 1.0 && index <= of && tail).then_some((index, of))
}

#[expect(
    clippy::float_cmp,
    reason = "slice indices are whole counts, compared exactly as JavaScript does"
)]
fn unbound(a: &Obj, b: &Obj) -> bool {
    let cost = |r: &Obj| {
        r.get("cost")
            .and_then(Js::as_obj)
            .cloned()
            .unwrap_or_default()
    };
    let (ca, cb) = (cost(a), cost(b));
    let distinct = slice(&ca)
        .zip(slice(&cb))
        .is_some_and(|(x, y)| x.1 == y.1 && x.0 != y.0);
    !truthy(ca.get("source"))
        || !truthy(cb.get("source"))
        || (ca.get("source") == cb.get("source") && !distinct)
}

fn either(a: &Obj, b: &Obj, p: Problem) -> bool {
    [a, b].iter().any(|r| problem(r.get("cost")) == Some(p))
}

/// The first condition the pair `a` (earlier) → `b` fails, or `clean`.
#[must_use]
pub fn status(a: &Obj, b: &Obj) -> &'static str {
    let engine = |r: &Obj| super::super::engine_text(r);
    let digests = |r: &Obj| {
        !get(r, "intentDigest").is_some_and(Js::is_string)
            || !get(r, "specDigest").is_some_and(Js::is_string)
    };
    let checks: [(&str, &dyn Fn() -> bool); 19] = [
        ("engine-unknown", &|| !attributed(a) || !attributed(b)),
        ("engine-changed", &|| engine(a) != engine(b)),
        ("prior-unconfirmed", &|| !chained_to(a, b)),
        ("diff-moved", &|| !same_diff(a, b)),
        ("dirty-tree", &|| {
            get(a, "dirty") != Some(&Js::Bool(false)) || get(b, "dirty") != Some(&Js::Bool(false))
        }),
        ("incomplete", &|| incomplete(a) || incomplete(b)),
        ("scope-not-full", &|| {
            a.text_units("lensScope") != "full" || b.text_units("lensScope") != "full"
        }),
        ("config-unknown", &|| digests(a) || digests(b)),
        ("config-changed", &|| config(a) != config(b)),
        ("memory-degraded", &|| !memory_intact(b)),
        ("cost-missing", &|| either(a, b, Problem::Missing)),
        ("cost-malformed", &|| either(a, b, Problem::Malformed)),
        ("cost-empty", &|| either(a, b, Problem::Empty)),
        ("cost-overcounted", &|| either(a, b, Problem::Overcounted)),
        ("cost-unknown-rule", &|| either(a, b, Problem::UnknownRule)),
        ("counts-malformed", &|| bad_count(a) || bad_count(b)),
        ("cost-partial", &|| either(a, b, Problem::Partial)),
        ("cost-unbound", &|| unbound(a, b)),
        ("clean", &|| true),
    ];
    checks
        .iter()
        .find(|(_, fails)| fails())
        .map_or("clean", |(s, _)| s)
}
