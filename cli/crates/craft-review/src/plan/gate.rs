//! The plan's last say on what yields (realm @nick/craft, node #625): a signal-gated lens runs
//! when, and only when, its profile's part shows its signal; a part of nothing but data is read by
//! the whole-diff lenses and the security lens alone. A lens held back for want of its signal stays
//! a candidate the completeness critic of a full review may name ([`crate::critic::candidates`]):
//! gated, never dropped; one that would read nothing of its part is none.

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

/// The data of a profile taking the rest ([`crate::coverage::is_data`]), judged over the paths its
/// lenses read, `read` (its files and the old paths of those renamed): a part with source among them
/// keeps its data from its per-file lenses, its current data files (of `own`) named in
/// `data_files`; an empty part is no data-only one; a part of nothing but data keeps only the
/// lenses that read it ([`Profile::reads`]), its always ones that do when it had none, the others
/// named in `data_skipped`.
pub(super) fn data(p: &Profile, (own, read): (&[String], &[String]), plan: &mut Plan) {
    if !p.detect.rest {
        return;
    }
    let is_data = |f: &&String| crate::coverage::is_data(f);
    if read.is_empty() || !read.iter().all(|f| is_data(&f)) {
        plan.data_files = own.iter().filter(is_data).cloned().collect();
        return;
    }
    let reads = |l: &String| !p.reads_nothing(l, read);
    let (kept, held): (Vec<String>, Vec<String>) = plan.lenses.drain(..).partition(reads);
    plan.lenses = kept;
    if plan.lenses.is_empty() {
        for l in p.always_lenses.iter().filter(|l| reads(l)) {
            push_missing(&mut plan.lenses, l);
        }
    }
    plan.data_skipped = held;
}
