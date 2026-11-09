//! What the CI map's fresh entries came to for the head, signal by signal, and how that verdict
//! lands in the gate (realm @nick/craft, node #482): a red check fails the track, a Block like a
//! local red; a green clippy passes it; anything else leaves it unknown, each silent signal named.

use super::Status;
use super::check::Acc;
use super::ci_read::{Light, Seen};
use crate::project::{CiEntry, Signal};

/// How one entry's check came out for the head.
enum Came {
    Green,
    Red,
    None(String),
}

/// What the map's fresh entries came to, signal by signal.
#[derive(Default)]
pub(super) struct Verdict<'a> {
    green: Vec<(Signal, Vec<&'a str>)>,
    red: Vec<&'a CiEntry>,
    silent: Vec<(Signal, String)>,
}

/// How `e`'s check came out in `seen`: each of its runs — the check itself, or a matrix job's
/// `<check> (…)` — red if any is, no signal if any gave none, else green.
fn came(e: &CiEntry, seen: &Seen) -> Came {
    let matrix = format!("{} (", e.check);
    let runs: Vec<&Light> = seen
        .iter()
        .filter(|(n, _)| *n == e.check || n.starts_with(&matrix))
        .map(|(_, l)| l)
        .collect();
    if runs.is_empty() {
        return Came::None(format!("no run of `{}` for the head", e.check));
    }
    if runs.contains(&&Light::Red) {
        return Came::Red;
    }
    match runs.iter().find_map(|l| match l {
        Light::None(s) => Some(s),
        Light::Green | Light::Red => None,
    }) {
        Some(s) => Came::None(format!("`{}` is {s}", e.check)),
        None => Came::Green,
    }
}

/// Each mapped signal's outcome: red when one of its checks is, silent when one gave none, green
/// when every one is.
pub(super) fn verdict<'a>(fresh: &[&'a CiEntry], seen: &Seen) -> Verdict<'a> {
    let mut v = Verdict::default();
    for signal in Signal::ALL {
        let of: Vec<(&CiEntry, Came)> = fresh
            .iter()
            .filter(|e| e.signal == signal)
            .map(|e| (*e, came(e, seen)))
            .collect();
        let red: Vec<&CiEntry> = of
            .iter()
            .filter(|(_, c)| matches!(c, Came::Red))
            .map(|(e, _)| *e)
            .collect();
        let why: Vec<&str> = of
            .iter()
            .filter_map(|(_, c)| match c {
                Came::None(w) => Some(w.as_str()),
                Came::Green | Came::Red => None,
            })
            .collect();
        if !red.is_empty() {
            v.red.extend(red);
        } else if !why.is_empty() {
            v.silent.push((signal, why.join("; ")));
        } else if !of.is_empty() {
            v.green
                .push((signal, of.iter().map(|(e, _)| e.check.as_str()).collect()));
        }
    }
    v
}

/// The verdict in `acc`: red fails it, a green clippy passes it, else it stays unknown.
pub(super) fn apply(acc: &mut Acc, v: &Verdict<'_>, short: &str) {
    if !v.green.is_empty() {
        let signals: Vec<&str> = v.green.iter().map(|(s, _)| s.as_str()).collect();
        let checks = unique(v.green.iter().flat_map(|(_, c)| c.iter().copied()));
        acc.parts.push(format!(
            "{} via CI ({}) for {short}",
            signals.join(", "),
            checks.join(", ")
        ));
    }
    for e in &v.red {
        let s = e.signal.as_str();
        acc.parts
            .push(format!("{s} via CI ({}): red for {short}", e.check));
        acc.failed.push(format!(
            "CI {} ({s}) is red for {short}: `{}`",
            e.check, e.command
        ));
    }
    if !v.green.is_empty() || !v.red.is_empty() {
        acc.parts
            .push("no line seeds: CI results carry none".to_owned());
    }
    for (s, why) in &v.silent {
        acc.notes.push(format!(
            "CI gave no {} signal for {short}: {why}",
            s.as_str()
        ));
    }
    let clippy = v.green.iter().any(|(s, _)| *s == Signal::Clippy);
    let unmapped = !clippy && !v.silent.iter().any(|(s, _)| *s == Signal::Clippy);
    if v.red.is_empty() && unmapped {
        acc.notes
            .push("the CI map names no clippy check, so the build signal stays unknown".to_owned());
    }
    acc.status = Some(if !v.red.is_empty() {
        Status::Fail
    } else if clippy {
        Status::Pass
    } else {
        Status::Unknown
    });
}

/// `names` in their first order, each once.
pub(super) fn unique<'a>(names: impl Iterator<Item = &'a str>) -> Vec<&'a str> {
    let mut out: Vec<&str> = Vec::new();
    for n in names {
        if !out.contains(&n) {
            out.push(n);
        }
    }
    out
}
