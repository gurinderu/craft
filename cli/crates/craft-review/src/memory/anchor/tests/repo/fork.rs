use super::super::record;
use super::{at, commit, ids};
use crate::memory::PriorDecision;
use crate::memory::priors::scope_check_on;

/// `HEAD` forked from a side branch merged into the trunk only after 2026-05-02, the side's commit
/// of `src/s.rs` dated before that day, the trunk's own of `src/t.rs` too: the base of a record of
/// the 2nd is the trunk tip's first-parent commit before the day, never the side's.
#[test]
fn a_dated_record_walks_the_trunk_from_its_tip_not_from_where_head_forks() {
    let t = tempfile::tempdir().unwrap();
    let d = t.path();
    let start = "2026-04-30T12:00:00+0000";
    at(d, start, &["init", "-q", "-b", "main"]);
    std::fs::create_dir_all(d.join("src")).unwrap();
    for f in ["s", "t", "u"] {
        std::fs::write(d.join(format!("src/{f}.rs")), "0\n").unwrap();
    }
    let root = commit(d, "src/u.rs", "0\n", start);
    at(d, start, &["checkout", "-qb", "side", &root]);
    let side = commit(d, "src/s.rs", "side\n", "2026-05-01T08:00:00+0000");
    at(d, start, &["checkout", "-q", "main"]);
    let trunk = commit(d, "src/t.rs", "1\n", "2026-05-01T09:00:00+0000");
    let merged = "2026-05-03T12:00:00+0000";
    at(d, merged, &["merge", "-q", "--no-ff", "-m", "side", "side"]);
    at(
        d,
        merged,
        &["update-ref", "refs/remotes/origin/main", "HEAD"],
    );
    let head = [
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
    ];
    at(d, merged, &head);
    at(d, merged, &["checkout", "-qb", "feat", &side]);
    commit(d, "src/f.rs", "feat\n", "2026-05-03T13:00:00+0000");
    assert_eq!(
        crate::git::last_before(d, "origin/main", "2026-05-02").unwrap(),
        Some(trunk)
    );
    let ds = [
        record("s-2nd", "src/s.rs", "", "2026-05-02"),
        record("t-2nd", "src/t.rs", "", "2026-05-02"),
        record("u-2nd", "src/u.rs", "", "2026-05-02"),
    ];
    let refs: Vec<&PriorDecision> = ds.iter().collect();
    let s = scope_check_on(d, &refs, "2026-05-04");
    // From the fork (the side's commit) or from HEAD, s.rs and t.rs would read unchanged: the
    // side's edit and the trunk's commit the checkout lacks both count as changes.
    assert_eq!(ids(&s.unchanged), ["u-2nd"], "{:?}", s.why_missing);
    assert!(s.missing.is_empty(), "{:?}", s.missing);
}
