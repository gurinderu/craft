//! `craft init` and the code graph the profile already holds (realm @nick/craft, node #529): a
//! write while the graph does not answer keeps a usable held graph; a graph that answers but
//! indexes nothing names the write that records it once indexed; a read-only `init` says what
//! the graph says now, labelled live, and where the profile holds otherwise.
#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "the fixture helpers fail the test loudly, like the tests they serve"
)]

mod graph_init;

use graph_init::{indexing, init, repo, stub};

const LOCKED: &str = "#!/bin/sh\necho 'database locked' >&2\nexit 3\n";
const NONE: &str = "#!/bin/sh\necho '{\"projects\":[]}'\n";

#[test]
fn a_write_while_the_graph_does_not_answer_keeps_the_usable_graph_held() {
    let tmp = tempfile::tempdir().unwrap();
    let t = tmp.path();
    let repo = repo(t);
    init(t, &indexing(t, &repo), &repo, "--write");
    let (v, profile) = init(t, &stub(t, LOCKED), &repo, "--write");
    assert_eq!(v["codeGraph"]["project"], "mine", "{v}");
    let says = v["codeGraphSays"].as_str().unwrap();
    assert!(
        says.contains("is not available (list_projects: database locked)"),
        "{says}"
    );
    assert!(
        says.contains("the profile keeps the code graph it held, project mine"),
        "{says}"
    );
    assert!(profile.contains("project = \"mine\""), "{profile}");
    assert!(!profile.contains("unavailable"), "{profile}");
}

#[test]
fn a_graph_that_indexes_nothing_names_the_write_that_records_it_once_indexed() {
    let tmp = tempfile::tempdir().unwrap();
    let t = tmp.path();
    let repo = repo(t);
    let (v, profile) = init(t, &stub(t, NONE), &repo, "--write");
    let says = v["codeGraphSays"].as_str().unwrap();
    assert!(says.contains("cli index_repository"), "{says}");
    assert!(
        says.contains("then record it with `craft init --write`"),
        "{says}"
    );
    assert!(profile.contains("state = \"unindexed\""), "{profile}");
}

#[test]
fn a_read_only_init_says_the_graph_now_and_where_the_profile_holds_otherwise() {
    let tmp = tempfile::tempdir().unwrap();
    let t = tmp.path();
    let repo = repo(t);
    let bin = indexing(t, &repo);
    init(t, &bin, &repo, "--write");
    let (v, _) = init(t, &bin, &repo, "--propose");
    let says = v["codeGraphSays"].as_str().unwrap();
    assert!(
        says.starts_with("now: codebase-memory-mcp answers"),
        "{says}"
    );
    assert!(!says.contains("the profile holds"), "{says}");
    let (v, _) = init(t, &stub(t, NONE), &repo, "--propose");
    assert_eq!(v["codeGraph"]["project"], "mine", "{v}");
    let says = v["codeGraphSays"].as_str().unwrap();
    assert!(
        says.starts_with("now: codebase-memory-mcp answers but does not index"),
        "{says}"
    );
    assert!(
        says.contains(
            "the profile holds project mine, which a review reads until a write records this"
        ),
        "{says}"
    );
}

#[test]
fn a_write_over_a_held_profile_it_cannot_read_leaves_its_code_graph_as_it_stands() {
    let tmp = tempfile::tempdir().unwrap();
    let t = tmp.path();
    let repo = repo(t);
    let (v, profile) = init(t, &indexing(t, &repo), &repo, "--write");
    // A repo of no shape a profile takes: the held profile is TOML but no longer reads.
    let path = v["profile"].as_str().unwrap().to_owned();
    assert!(profile.contains("\nrepo = "), "{profile}");
    std::fs::write(
        &path,
        profile.replace("\nrepo = ", "\nrepo = 5\nold_repo = "),
    )
    .unwrap();
    let (v, profile) = init(t, &stub(t, LOCKED), &repo, "--write");
    let says = v["codeGraphSays"].as_str().unwrap();
    assert!(
        says.contains("the profile held could not be read"),
        "{says}"
    );
    assert!(
        says.contains("its code graph section is left as it stands"),
        "{says}"
    );
    assert!(v["codeGraph"].is_null(), "{v}");
    assert!(profile.contains("project = \"mine\""), "{profile}");
    assert!(!profile.contains("unavailable"), "{profile}");
}
