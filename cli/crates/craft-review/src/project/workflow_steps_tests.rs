//! A job's run lines are those whose failure fails it (realm @nick/craft, node #482): a step or a
//! job that continues on error gives none, and an inline plain value ends at its comment.

use super::workflow::jobs;

#[test]
fn a_step_or_job_continuing_on_error_gives_no_run_line() {
    let yml = "jobs:\n  a:\n    steps:\n      - run: cargo fmt --check\n        continue-on-error: true\n      - name: kept\n        continue-on-error: false\n        run: cargo test\n      - continue-on-error: ${{ matrix.x }}\n        run: |\n          cargo build\n  b:\n    continue-on-error: true\n    steps:\n      - run: cargo test\n  c:\n    steps:\n      - run: cargo test\n    continue-on-error: \"true\"\n";
    let got = jobs(yml);
    assert_eq!(got[0].runs, ["cargo test"]);
    assert!(got[1].runs.is_empty(), "{:?}", got[1]);
    assert!(got[2].runs.is_empty(), "{:?}", got[2]);
}

#[test]
fn an_inline_plain_run_ends_at_its_comment_and_a_quoted_one_keeps_its_text() {
    let yml = "jobs:\n  a:\n    steps:\n      - run: true # cargo clippy\n      - run: \"cargo test #1\" # note\n      - run: 'cargo build'\n      - run: cargo doc#x\n      - run: | # a block\n          cargo fmt\n";
    assert_eq!(
        jobs(yml)[0].runs,
        [
            "true",
            "cargo test #1",
            "cargo build",
            "cargo doc#x",
            "cargo fmt"
        ]
    );
}
