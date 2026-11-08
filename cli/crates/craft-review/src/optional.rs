//! The optional pass (`optional`), as `parseOptionalRequest` in `lib/review-lens-tallies.mjs`
//! reads it: off by default; `all` (or `true`) buys every optional lens, a list of names buys
//! those, and a name that is no optional lens is named in a note rather than silently dropped, the
//! recognised ones still admitted. A lens is named by its id (`performance`) or qualified by its
//! profile (`rust-performance`); the request is kept qualified, so a name buys only the lens of the
//! profile that holds it as optional.

use crate::profile::{Lens, Profile};

/// The values that buy no optional lens, and those that buy the whole set.
const NONE: [&str; 3] = ["", "false", "none"];
const ALL: [&str; 2] = ["all", "true"];

/// A lens as the request keeps it: `<profile>-<lens>`.
fn qualified(p: &Profile, l: &Lens) -> String {
    format!("{}-{}", p.id, l.id)
}

/// What a request buys: the qualified optional lenses it names, and the names that are none.
#[must_use]
pub fn request(raw: Option<&str>, profiles: &[Profile]) -> (Vec<String>, Vec<String>) {
    let raw = raw.unwrap_or("").trim();
    let roster: Vec<(String, &str)> = profiles
        .iter()
        .flat_map(|p| {
            p.lenses
                .iter()
                .filter(|l| l.optional)
                .map(move |l| (qualified(p, l), l.id.as_str()))
        })
        .collect();
    if NONE.contains(&raw.to_ascii_lowercase().as_str()) {
        return (Vec::new(), Vec::new());
    }
    if ALL.contains(&raw.to_ascii_lowercase().as_str()) {
        return (roster.into_iter().map(|(q, _)| q).collect(), Vec::new());
    }
    let (mut bought, mut unknown) = (Vec::new(), Vec::new());
    for name in raw.split([',', ' ', '\t', '\n']).filter(|n| !n.is_empty()) {
        let hits: Vec<&String> = roster
            .iter()
            .filter(|(q, id)| q == name || *id == name)
            .map(|(q, _)| q)
            .collect();
        if hits.is_empty() {
            unknown.push(name.to_owned());
        }
        for q in hits {
            if !bought.contains(q) {
                bought.push(q.clone());
            }
        }
    }
    (bought, unknown)
}

/// The note a request naming what is no optional lens leaves; `None` when it named only optional
/// ones.
#[must_use]
pub fn unknown_note(raw: &str, unknown: &[String], profiles: &[Profile]) -> Option<String> {
    if unknown.is_empty() {
        return None;
    }
    let (roster, _) = request(Some("all"), profiles);
    Some(format!(
        "optional={raw:?} names {}, which is not an optional lens — the optional roster is {}. Only the recognised names were admitted.",
        unknown.join(", "),
        roster.join(", ")
    ))
}

/// Whether `lens` of `p` may enter a plan: an optional lens only when `requested` buys it.
#[must_use]
pub fn admitted(p: &Profile, lens: &str, requested: &[String]) -> bool {
    p.lens(lens)
        .is_none_or(|l| !l.optional || requested.contains(&qualified(p, l)))
}

/// The optional lenses of `p` that `requested` buys, in its roster's order.
#[must_use]
pub fn bought(p: &Profile, requested: &[String]) -> Vec<String> {
    p.lenses
        .iter()
        .filter(|l| l.optional && requested.contains(&qualified(p, l)))
        .map(|l| l.id.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rust() -> Vec<Profile> {
        vec![
            Profile::load("rust").unwrap(),
            Profile::load("general").unwrap(),
        ]
    }

    #[test]
    fn a_request_buys_by_id_or_by_qualified_name_and_names_the_rest() {
        let ps = rust();
        assert_eq!(request(None, &ps), (vec![], vec![]));
        assert_eq!(request(Some("false"), &ps), (vec![], vec![]));
        let (all, _) = request(Some("all"), &ps);
        assert_eq!(
            all,
            ["rust-performance", "rust-api-idioms", "rust-api-boundary"]
        );
        assert_eq!(request(Some("true"), &ps).0, all);
        let (got, unknown) = request(Some("rust-performance, api-boundary perf"), &ps);
        assert_eq!(got, ["rust-performance", "rust-api-boundary"]);
        assert_eq!(unknown, ["perf"]);
        let note = unknown_note("perf", &unknown, &ps).unwrap();
        assert!(note.contains("names perf") && note.contains("rust-api-idioms"));
    }

    #[test]
    fn only_a_requested_optional_lens_is_admitted() {
        let ps = rust();
        let p = &ps[0];
        assert!(!admitted(p, "performance", &[]));
        assert!(admitted(p, "performance", &["rust-performance".into()]));
        assert!(admitted(p, "safety", &[]));
        // The general profile's performance lens is no optional one: a request does not touch it.
        assert!(admitted(&ps[1], "performance", &[]));
        assert_eq!(bought(p, &["rust-api-idioms".into()]), ["api-idioms"]);
    }
}
