use super::*;
use serde_json::json;

#[test]
fn only_a_finding_a_question_named_is_dropped_confirmed_or_converted() {
    let f = |lens: &str, title: &str| json!({"source": lens, "file": "crates/b/src/lib.rs", "line": 3, "title": title, "severity": "High"});
    let pool = vec![
        f("errors", "Leaks  the handle"),
        f("tests", "Leaks the handle"),
        f("errors", "other"),
    ];
    let asked = json!({"lens": "errors", "findingFile": "crates/b/src/lib.rs ", "findingTitle": "leaks the handle"});
    let drop = json!({"lens": "errors", "findingFile": "crates/b/src/lib.rs", "findingTitle": "Leaks the handle", "action": "drop", "why": "a closes it"});
    let stray = json!({"lens": "errors", "findingFile": "crates/b/src/lib.rs", "findingTitle": "other", "action": "drop", "why": "x"});
    let (kept, counts, aside) = apply(pool, &[drop, stray], &[asked]);
    assert_eq!(kept.len(), 2);
    assert_eq!(
        counts,
        Counts {
            confirm: 0,
            drop: 1,
            convert: 0
        }
    );
    assert_eq!(
        (aside[0].lens.as_str(), aside[0].why.as_str()),
        ("errors", "a closes it")
    );
    assert!(section(aside.iter()).contains(
        "- drop · High · `crates/b/src/lib.rs:3` · errors · Leaks  the handle — a closes it"
    ));
    assert_eq!(section([].iter()), "");
}

#[test]
fn a_disposition_of_the_second_lens_s_exact_copy_takes_the_finding_and_only_matches_count() {
    let copy = json!({"source": "errors", "sources": ["errors", "tests"], "file": "crates/b/src/lib.rs", "line": 3, "title": "Leaks the handle", "severity": "High"});
    let asked = |lens: &str, title: &str| json!({"lens": lens, "findingFile": "crates/b/src/lib.rs", "findingTitle": title});
    let decide = |lens: &str, title: &str, action: &str| json!({"lens": lens, "findingFile": "crates/b/src/lib.rs", "findingTitle": title, "action": action, "why": "w"});
    let questions = [
        asked("tests", "Leaks the handle"),
        asked("errors", "gone already"),
    ];
    let dispositions = [
        decide("tests", "Leaks the handle", "drop"),
        decide("errors", "gone already", "confirm"),
    ];
    let (kept, counts, aside) = apply(vec![copy], &dispositions, &questions);
    assert!(kept.is_empty());
    assert_eq!((aside.len(), aside[0].lens.as_str()), (1, "errors"));
    assert_eq!(
        counts,
        Counts {
            confirm: 0,
            drop: 1,
            convert: 0
        }
    );
}

#[test]
fn a_finding_given_conflicting_dispositions_counts_once_and_a_drop_wins_over_a_later_confirm() {
    let copy = json!({"source": "errors", "sources": ["errors", "tests"], "file": "a.rs", "line": 1, "title": "t", "severity": "Low"});
    let named = |lens: &str| json!({"lens": lens, "findingFile": "a.rs", "findingTitle": "t"});
    let decide = |lens: &str, action: &str| json!({"lens": lens, "findingFile": "a.rs", "findingTitle": "t", "action": action, "why": action});
    let questions = [named("errors"), named("tests")];
    let dispositions = [
        decide("errors", "drop"),
        decide("errors", "confirm"),
        decide("tests", "confirm"),
    ];
    let (kept, counts, aside) = apply(vec![copy], &dispositions, &questions);
    assert!(kept.is_empty());
    assert_eq!(aside[0].why, "drop");
    assert_eq!(
        counts,
        Counts {
            confirm: 0,
            drop: 1,
            convert: 0
        }
    );
}
