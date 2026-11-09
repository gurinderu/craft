//! CI informs, it never certifies (realm @nick/craft, node #482): a green clippy check read from
//! CI never gives the track `Status::Pass`, whatever the map holds besides it.

use super::Status;
use super::ci_world::{FMT_GREEN, entry, gated, runs, save, short, world};

#[test]
fn a_green_clippy_via_ci_never_passes_the_gate_whatever_the_map_says() {
    let all_green = runs(&[
        ("clippy", "completed", "success"),
        ("tests", "completed", "success"),
    ]);
    let maps: [&[(&str, &str, &str)]; 3] = [
        &[(
            "clippy",
            "clippy",
            "cargo clippy --all-targets -- -D warnings",
        )],
        &[
            (
                "clippy",
                "clippy",
                "cargo clippy --all-targets -- -D warnings",
            ),
            ("tests", "test", "cargo test --locked"),
        ],
        &[
            (
                "clippy",
                "clippy",
                "cargo clippy --all-targets -- -D warnings",
            ),
            ("tests", "test", "cargo test --locked"),
            ("fmt", "fmt", "cargo fmt --check"),
        ],
    ];
    for map in maps {
        let w = world(&all_green, FMT_GREEN);
        let top = w.repo.path();
        let ci = map
            .iter()
            .map(|(c, s, cmd)| entry(top, c, s, cmd))
            .collect();
        save(w.projects.path(), top, ci);
        let (gate, t) = gated(&w);
        assert_ne!(t.status, Status::Pass, "{map:?}: {t:?}");
        assert_eq!(t.status, Status::Unknown, "{map:?}: {t:?}");
        assert!(gate.exit().is_none(), "{map:?}: green does not block");
        let informs = format!("CI for {}: clippy", short(&w));
        assert!(
            t.provenance.contains(&informs) && t.provenance.contains("informs only, not a pass"),
            "{map:?}: {}",
            t.provenance
        );
    }
}
