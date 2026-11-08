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
