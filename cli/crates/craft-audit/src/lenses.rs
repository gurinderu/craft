//! Which of a profile's lenses an audit runs: those of its roster that judge code as it stands.
//! Left out, and named in the report: a lens only an explicit request admits (`optional`), one a
//! diff signal or a scout's pick admits (`conditional`) — an audit computes neither —, one whose
//! subject is the change itself (`wholeDiff`: intent, compatibility, invariants, failure windows),
//! a metrics-or-nothing lens, which needs the code graph's numbers, and the floor lenses, which
//! inventory a change's new surface.

use craft_review::profile::{Lens, Profile};

/// Whether an audit runs `lens`.
#[must_use]
pub fn judges_as_it_stands(lens: &Lens) -> bool {
    !(lens.optional || lens.conditional || lens.whole_diff || lens.metrics)
}

/// The lenses of `profile` an audit runs, in its roster's order.
#[must_use]
pub fn audited(profile: &Profile) -> Vec<&Lens> {
    profile
        .lenses
        .iter()
        .filter(|l| judges_as_it_stands(l))
        .collect()
}

/// The ids of `profile`'s lenses an audit does not run, roster then floors.
#[must_use]
pub fn left(profile: &Profile) -> Vec<String> {
    profile.flagged(|l| !profile.offers(&l.id) || !judges_as_it_stands(l))
}

#[cfg(test)]
mod tests {
    use super::{audited, left};
    use craft_review::profile::Profile;

    fn ids(p: &Profile) -> Vec<String> {
        audited(p).iter().map(|l| l.id.clone()).collect()
    }

    #[test]
    fn the_general_profile_runs_its_lenses_of_code_as_it_stands_and_names_the_rest() {
        let p = Profile::load("general").unwrap();
        assert_eq!(
            ids(&p),
            ["correctness", "security", "concurrency", "errors", "tests"]
        );
        let left = left(&p);
        for id in [
            "intent",
            "compat",
            "money",
            "complexity",
            "design",
            "negative-space",
        ] {
            assert!(left.iter().any(|l| l == id), "{id} in {left:?}");
        }
        assert!(!left.iter().any(|l| l == "security"), "{left:?}");
    }

    #[test]
    fn the_rust_profile_runs_its_own_lenses_beside_those_it_inherits() {
        let p = Profile::load("rust").unwrap();
        let got = ids(&p);
        for id in ["safety", "reconciler", "correctness", "security", "errors"] {
            assert!(got.iter().any(|l| l == id), "{id} in {got:?}");
        }
        for id in ["intent", "failure-windows", "api-idioms", "performance"] {
            assert!(!got.iter().any(|l| l == id), "{id} in {got:?}");
        }
    }

    #[test]
    fn every_lens_of_a_profile_is_run_or_left_never_both() {
        for id in crate::scout::PROFILES {
            let p = Profile::load(id).unwrap();
            let (run, left) = (ids(&p), left(&p));
            let every = p.lenses.len() + p.floor_lenses.len();
            assert_eq!(run.len() + left.len(), every, "{id}");
            assert!(run.iter().all(|r| !left.contains(r)), "{id}");
        }
    }
}
