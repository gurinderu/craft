//! `craft review post` and `craft pr rejections` end to end, as the addressing-findings skill runs
//! them, against a stand-in `gh` on the PATH: a chosen doubtful finding is posted with the marker
//! and its choice lands in the run's record; a PR's threads are read across pages and printed as
//! the decision records the JavaScript reader printed; what cannot be read exits 2.
#![cfg(unix)]
#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "the fixture fails the test loudly, like the tests it serves"
)]

#[path = "pr_post/from_record.rs"]
mod from_record;
#[path = "pr_post/posting.rs"]
mod posting;
#[path = "pr_post/rejections.rs"]
mod rejections;
#[path = "pr_post/support.rs"]
mod support;
#[path = "pr_post/which_record.rs"]
mod which_record;
