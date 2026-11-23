//! The plan's last say on what yields (realm @nick/craft, node #625): a signal-gated lens runs
//! when, and only when, its profile's part shows its signal; a part of nothing but data is read by
//! the whole-diff lenses alone. What either holds back stays a candidate the completeness critic of
//! a full review may name ([`crate::critic::candidates`]): gated, never dropped.

use super::{Plan, push_missing};
use crate::profile::Profile;

/// Adds each gated lens of `p` whose signal `fired` shows and removes each whose signal it does
/// not, whoever planned it; strict mode keeps `maintainability`, which it asked for by name.
/// `fired` unknown (`None`) admits every gated lens.
pub(super) fn signals(p: &Profile, (fired, strict): (Option<&[String]>, bool), plan: &mut Plan) {
    let on = |s: &str| fired.is_none_or(|f| f.iter().any(|x| x == s));
    for l in &p.lenses {
        if l.signal.as_deref().is_some_and(on) {
            push_missing(&mut plan.lenses, &l.id);
        }
    }
    let held = |id: &str| {
        let gated = p.lens(id).and_then(|l| l.signal.as_deref());
        gated.is_some_and(|s| !on(s)) && !(strict && id == "maintainability")
    };
    plan.lenses.retain(|l| !held(l));
    plan.signal_skipped = p
        .lenses
        .iter()
        .filter(|l| held(&l.id))
        .map(|l| l.id.clone())
        .collect();
}

/// A profile taking the rest whose part `own` is nothing but data keeps only its whole-diff
/// lenses, its whole-diff always lenses when it had none; the others join `signal_skipped`.
pub(super) fn data_only(p: &Profile, own: &[String], plan: &mut Plan) {
    if !p.detect.rest || own.is_empty() || !own.iter().all(|f| crate::coverage::is_data(f)) {
        return;
    }
    let whole = |id: &str| p.lens(id).is_some_and(|l| l.whole_diff);
    let (kept, held): (Vec<String>, Vec<String>) = plan.lenses.drain(..).partition(|l| whole(l));
    plan.lenses = kept;
    if plan.lenses.is_empty() {
        for l in p.always_lenses.iter().filter(|l| whole(l)) {
            push_missing(&mut plan.lenses, l);
        }
    }
    for l in held {
        push_missing(&mut plan.signal_skipped, &l);
    }
}
