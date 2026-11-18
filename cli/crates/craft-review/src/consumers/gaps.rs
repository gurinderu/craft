//! Every gap field of a consumers list in one place: who is told of it — the lenses and the
//! report, or the report alone — and how each words it. The lenses are told only what they can
//! act on (lines and names the list could not search, files it could not read).

use super::Consumers;
use super::list::SYMBOLS_MAX;

/// One gap field: its name as the run state writes it, whether the lenses are told, and the
/// report's and the lenses' lines when it holds anything.
pub(super) struct Gap {
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "read by the test holding the list to the fields")
    )]
    pub field: &'static str,
    pub to_lens: bool,
    /// The report's line and the lenses' sentence, `None` when the field is empty.
    pub said: Option<(String, String)>,
}

/// A list field told to both audiences: the report counts and shows it, the lens names it.
fn both(field: &'static str, v: &[String], report: &str, lens: &str) -> Gap {
    Gap {
        field,
        to_lens: true,
        said: (!v.is_empty()).then(|| {
            (
                format!("- {} {report}: {}\n", v.len(), shown(v)),
                format!("{lens}: {}.", shown(v)),
            )
        }),
    }
}

/// Every gap field of `c`, in the order both outputs print them.
pub(super) fn all(c: &Consumers) -> Vec<Gap> {
    vec![
        Gap {
            field: "failed",
            to_lens: true,
            said: (!c.failed.is_empty()).then(|| {
                (
                    format!("- Not built: {}\n", c.failed),
                    format!(
                        "No consumers list could be built ({}): find the uses of every item the change touches yourself.",
                        c.failed
                    ),
                )
            }),
        },
        both(
            "unreadable",
            &c.unreadable,
            "changed file(s) not read, their symbols not searched",
            "Changed files not read, their symbols not searched (read them and find the uses yourself)",
        ),
        both(
            "unlisted",
            &c.unlisted,
            &format!("changed symbol(s) past the {SYMBOLS_MAX}-symbol limit, not searched"),
            &format!(
                "Changed symbols past the {SYMBOLS_MAX}-symbol limit, not searched (find their uses yourself)"
            ),
        ),
        both(
            "unsearched",
            &c.unsearched,
            "changed symbol(s) not searched by name",
            "Not searched by name (find their uses yourself)",
        ),
        both(
            "unplaced",
            &c.unplaced,
            "changed line(s) in no item the list could name, their uses not searched",
            "Changed lines in no item this list could name (find what they change and its uses yourself)",
        ),
    ]
}

/// The lenses' sentences on what `c` could not search.
pub(super) fn for_lens(c: &Consumers) -> Vec<String> {
    all(c)
        .into_iter()
        .filter(|g| g.to_lens)
        .filter_map(|g| g.said.map(|(_, lens)| lens))
        .collect()
}

/// The report's lines on every gap of `c`.
pub(super) fn for_report(c: &Consumers) -> String {
    all(c)
        .into_iter()
        .filter_map(|g| g.said.map(|(report, _)| report))
        .collect()
}

/// How many entries of a list a text names before it counts the rest.
const SHOWN_MAX: usize = 20;

/// `v` joined, past [`SHOWN_MAX`] entries counted instead of named.
pub(super) fn shown(v: &[String]) -> String {
    let head = v
        .iter()
        .take(SHOWN_MAX)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    match v.len().saturating_sub(SHOWN_MAX) {
        0 => head,
        more => format!("{head} and {more} more"),
    }
}
