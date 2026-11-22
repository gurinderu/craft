//! `craft runs develop-cycle`: one craft:develop cycle as a run record (realm @nick/craft, nodes
//! #281, #278, #263, #39) — its rounds (each one's engine, whether it reviewed the whole branch diff
//! or the fixed delta, its verdict and open Medium+ count), its outcome and every full review run
//! after convergence — read strictly as `readDevelopCycle` in `integrations/shared/develop-cycle.mjs`
//! reads it (the record frozen in `content/parity/posthoc-store-cases.json`): a refusal names the first field that does not fit.

use crate::js::{Js, JsString, Obj};

const OUTCOMES: [&str; 3] = ["converged", "capped", "no-verdict"];
const MODES: [&str; 2] = ["light", "full"];
/// Generous beyond the 4-round cap of node #263: a project that declares its own cap is recorded as it ran.
const ROUNDS_MAX: usize = 12;
const TEXT_MAX: usize = 120;

/// `JSON.stringify(v)` in a message: `undefined` for what is absent.
fn shown(v: Option<&Js>) -> String {
    v.map_or_else(|| "undefined".to_owned(), Js::compact)
}

/// Whether a UTF-16 unit is one `String.prototype.trim` strips.
fn js_space(u: u16) -> bool {
    matches!(u, 0x09..=0x0D | 0x20 | 0xA0 | 0x1680 | 0x2000..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF)
}

/// A short one-line text field, trimmed.
fn text(v: Option<&Js>, what: &str) -> Result<Js, String> {
    let fail = || {
        Err(format!(
            "{what} must be a one-line string of at most {TEXT_MAX} chars, got {}",
            shown(v)
        ))
    };
    let Some(Js::Str(s)) = v else { return fail() };
    let units: Vec<u16> = s.units().collect();
    let from = units.iter().position(|u| !js_space(*u));
    let to = units.iter().rposition(|u| !js_space(*u));
    let (Some(from), Some(to)) = (from, to) else {
        return fail();
    };
    if units.len() > TEXT_MAX || units.iter().any(|u| *u < 32) {
        return fail();
    }
    Ok(Js::str(JsString::from_utf16(
        units.get(from..=to).unwrap_or(&[]).to_vec(),
    )))
}

fn integer(v: Option<&Js>) -> Option<f64> {
    v.and_then(Js::as_num)
        .filter(|n| n.is_finite() && n.fract() == 0.0)
}

/// A count of open Medium+ findings, `null` when the round had no verdict.
fn count(v: Option<&Js>, what: &str) -> Result<Js, String> {
    if v == Some(&Js::Null) {
        return Ok(Js::Null);
    }
    match integer(v) {
        Some(n) if n >= 0.0 => Ok(Js::Num(n)),
        _ => Err(format!(
            "{what} must be a non-negative integer or null, got {}",
            shown(v)
        )),
    }
}

fn obj<'a>(v: Option<&'a Js>, what: &str) -> Result<&'a Obj, String> {
    v.and_then(Js::as_obj)
        .ok_or_else(|| format!("{what} must be an object"))
}

fn one_of(v: Option<&Js>, what: &str, allowed: &[&str]) -> Result<Js, String> {
    match v.and_then(Js::as_str) {
        Some(s) if allowed.contains(&s) => Ok(Js::str(s)),
        _ => Err(format!(
            "{what} must be one of {}, got {}",
            allowed.join(", "),
            shown(v)
        )),
    }
}

fn read_round(v: &Js, i: usize) -> Result<Obj, String> {
    let at = format!("rounds[{i}]");
    let o = obj(Some(v), &at)?;
    let scope = o.get("scope");
    if !matches!(scope.and_then(Js::as_str), Some("full" | "delta")) {
        return Err(format!(
            "{at}.scope must be \"full\" or \"delta\", got {}",
            shown(scope)
        ));
    }
    #[expect(clippy::cast_precision_loss, reason = "at most twelve rounds")]
    let n = (i + 1) as f64;
    Ok(Obj::new()
        .with("n", Js::Num(n))
        .with("engine", text(o.get("engine"), &format!("{at}.engine"))?)
        .with("scope", scope.cloned().unwrap_or(Js::Null))
        .with("verdict", text(o.get("verdict"), &format!("{at}.verdict"))?)
        .with(
            "mediumPlus",
            count(o.get("mediumPlus"), &format!("{at}.mediumPlus"))?,
        ))
}

fn read_full_review(v: &Js, i: usize, rounds: usize) -> Result<Obj, String> {
    let at = format!("fullReviews[{i}]");
    let o = obj(Some(v), &at)?;
    let after = o.get("afterRound");
    #[expect(clippy::cast_precision_loss, reason = "at most twelve rounds")]
    let within = integer(after).filter(|n| *n >= 1.0 && *n <= rounds as f64);
    let Some(after_round) = within else {
        return Err(format!(
            "{at}.afterRound must name one of the {rounds} round(s), got {}",
            shown(after)
        ));
    };
    Ok(Obj::new()
        .with("afterRound", Js::Num(after_round))
        .with("engine", text(o.get("engine"), &format!("{at}.engine"))?)
        .with("verdict", text(o.get("verdict"), &format!("{at}.verdict"))?)
        .with(
            "mediumPlus",
            count(o.get("mediumPlus"), &format!("{at}.mediumPlus"))?,
        ))
}

/// `null` or absent, as `??` reads it.
fn present(v: Option<&Js>) -> Option<&Js> {
    v.filter(|v| **v != Js::Null)
}

/// Whether the last round, and every full review run after it, left no open Medium+.
fn ends_clean(rounds: &[Obj], full: &[Obj]) -> bool {
    #[expect(clippy::cast_precision_loss, reason = "at most twelve rounds")]
    let last_n = rounds.len() as f64;
    let zero = |o: &Obj| o.get("mediumPlus") == Some(&Js::Num(0.0));
    let full_clean = full
        .iter()
        .all(|f| f.get("afterRound") != Some(&Js::Num(last_n)) || zero(f));
    rounds.last().is_some_and(zero) && full_clean
}

/// The run record of a cycle: `kind` develop, the outcome as its verdict, its round count as
/// `round`, the cycle under `develop`; the writer stamps the project, branch, head and time.
///
/// # Errors
/// Naming the first field of `payload` that does not fit.
pub fn cycle_record(payload: &Obj) -> Result<Obj, String> {
    let mode = one_of(
        Some(present(payload.get("mode")).unwrap_or(&Js::str("light"))),
        "mode",
        &MODES,
    )?;
    let outcome = one_of(payload.get("outcome"), "outcome", &OUTCOMES)?;
    let raw = payload
        .get("rounds")
        .and_then(Js::as_arr)
        .filter(|r| !r.is_empty() && r.len() <= ROUNDS_MAX);
    let raw = raw.ok_or_else(|| format!("rounds must hold 1 to {ROUNDS_MAX} round(s)"))?;
    let rounds = raw
        .iter()
        .enumerate()
        .map(|(i, v)| read_round(v, i))
        .collect::<Result<Vec<_>, _>>()?;
    let full_raw = match present(payload.get("fullReviews")) {
        None => &[][..],
        Some(Js::Arr(a)) => a.as_slice(),
        Some(_) => return Err("fullReviews must be an array".into()),
    };
    let full = full_raw
        .iter()
        .enumerate()
        .map(|(i, v)| read_full_review(v, i, rounds.len()))
        .collect::<Result<Vec<_>, _>>()?;
    if outcome.as_str() == Some("converged") && !ends_clean(&rounds, &full) {
        return Err("outcome \"converged\" needs the last round, and a full review after it, to leave no open Medium+".into());
    }
    #[expect(clippy::cast_precision_loss, reason = "at most twelve rounds")]
    let round = rounds.len() as f64;
    let cycle = Obj::new()
        .with("mode", mode)
        .with("outcome", outcome.clone())
        .with("rounds", Js::Arr(rounds.into_iter().map(Js::Obj).collect()))
        .with(
            "fullReviews",
            Js::Arr(full.into_iter().map(Js::Obj).collect()),
        );
    Ok(Obj::new()
        .with("schemaVersion", Js::Num(1.0))
        .with("runtime", Js::str("claude-code"))
        .with("kind", Js::str("develop"))
        .with("name", Js::str("develop"))
        .with("verdict", outcome)
        .with("round", Js::Num(round))
        .with("develop", Js::Obj(cycle)))
}

#[cfg(test)]
mod tests;
