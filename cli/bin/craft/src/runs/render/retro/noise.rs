//! The lenses that over-refute — the ones whose rubric a reader would tighten — and the craft
//! versions whose runs carry more than one engine revision, which `--version` cannot tell apart.

use std::cmp::Ordering;
use std::io::{self, Write};

use craft_store::js::{Js, Obj};
use craft_store::retro::{Lens, Retro};

use super::super::{line, num};

/// A refute rate means something over this many candidates.
pub const MIN_CANDIDATES: f64 = 4.0;
/// A lens refuting below this is precise, not noisy.
pub const MIN_RATE: f64 = 0.25;

/// The lenses with enough candidates for a rate, and of those the noisy ones, highest first.
fn noisy<'a>(lenses: &[(&'a String, &'a Lens)]) -> (usize, Vec<(&'a String, &'a Lens, f64)>) {
    let rated: Vec<_> = lenses
        .iter()
        .filter_map(|(n, l)| {
            l.refute_rate()
                .filter(|_| l.candidates() >= MIN_CANDIDATES)
                .map(|r| (*n, *l, r))
        })
        .collect();
    let mut noisy: Vec<_> = rated
        .iter()
        .copied()
        .filter(|(_, _, r)| *r >= MIN_RATE)
        .collect();
    noisy.sort_by(|a, b| {
        b.2.total_cmp(&a.2)
            .then(b.1.candidates().total_cmp(&a.1.candidates()))
    });
    (rated.len(), noisy)
}

pub fn json(out: &mut dyn Write, lenses: &[(&String, &Lens)]) -> io::Result<()> {
    for (name, l, rate) in noisy(lenses).1 {
        let o = Obj::new()
            .with("section", Js::str("noise"))
            .with("lens", Js::str(name))
            .with("refuteRate", Js::Num(rate))
            .with("refuted", Js::Num(l.refuted))
            .with("candidates", Js::Num(l.candidates()))
            .with("confirmed", Js::Num(l.confirmed))
            .with("refuteBasis", l.refute_basis().map_or(Js::Null, Js::str));
        line(out, o)?;
    }
    Ok(())
}

pub fn text(out: &mut dyn Write, lenses: &[(&String, &Lens)]) -> io::Result<()> {
    writeln!(
        out,
        "\nNoise (lenses refuting ≥ {MIN_RATE} over ≥ {MIN_CANDIDATES} candidates)"
    )?;
    let (rated, noisy) = noisy(lenses);
    if noisy.is_empty() {
        return if rated > 0 {
            writeln!(
                out,
                "none: all {rated} lens(es) with enough candidates refute below {MIN_RATE}"
            )
        } else {
            writeln!(out, "no per-lens refute data yet")
        };
    }
    for (name, l, rate) in noisy {
        let basis = match l.refute_basis() {
            Some("mixed") => " · refute basis mixed: not like-for-like, confirm before tightening",
            Some("legacy") => " · refute basis legacy: unjudged candidates inflate the rate",
            _ => "",
        };
        writeln!(
            out,
            "{name}: refute {} ({}/{}) · {} confirmed — tighten this lens's rubric{basis}",
            num(rate),
            num(l.refuted),
            num(l.candidates()),
            num(l.confirmed)
        )?;
    }
    Ok(())
}

/// `r<N>` by its number, `r?` last.
fn rev_order(a: &str, b: &str) -> Ordering {
    let n = |s: &str| {
        s.strip_prefix('r')
            .and_then(|n| n.parse::<f64>().ok())
            .unwrap_or(f64::INFINITY)
    };
    n(a).total_cmp(&n(b))
}

/// Versions segment by segment as numbers, a segment not numeric on both sides as text.
fn semver(a: &str, b: &str) -> Ordering {
    let (pa, pb): (Vec<&str>, Vec<&str>) = (a.split('.').collect(), b.split('.').collect());
    for i in 0..pa.len().max(pb.len()) {
        let (sa, sb) = (
            pa.get(i).copied().unwrap_or(""),
            pb.get(i).copied().unwrap_or(""),
        );
        let num = |s: &str| Some(craft_store::js::number_of_text(s)).filter(|n| n.is_finite());
        let o = match (num(sa), num(sb)) {
            (Some(x), Some(y)) => x.total_cmp(&y),
            _ => super::utf16(sa, sb),
        };
        if o != Ordering::Equal {
            return o;
        }
    }
    Ordering::Equal
}

/// The versions whose runs carry more than one engine revision, each with them in order.
pub fn collisions(r: &Retro) -> Vec<(&String, Vec<&String>)> {
    let mut out: Vec<_> = r
        .revisions
        .iter()
        .filter(|(_, revs)| revs.len() > 1)
        .map(|(v, revs)| {
            let mut revs: Vec<&String> = revs.iter().collect();
            revs.sort_by(|a, b| rev_order(a, b));
            (v, revs)
        })
        .collect();
    out.sort_by(|a, b| semver(a.0, b.0));
    out
}
