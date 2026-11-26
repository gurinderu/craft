use serde_json::json;

use super::{Pull, Repo, pulls};
use crate::memory::anchor::tests::repo::at;

fn p(repo: &str, number: u64) -> Pull {
    Pull {
        repo: repo.into(),
        number,
    }
}

#[test]
fn a_pull_request_link_is_a_github_pull_url_and_nothing_else_is() {
    let links = json!([
        "https://github.com/owner/repo/pull/7",
        " https://github.com/Owner/Repo/pull/8#discussion_r1 ",
        "HTTPS://GITHUB.COM/o.w_n-er/r.e_p-o/PULL/9/files",
        "https://github.com/o/r/pull/10?diff=split",
        "https://github.com/o/r/pull/123456789",
        "https://github.com/o/r/pull/1234567890",
        "https://github.com/o/r/pull/012",
        "https://github.com/o/r/pull/0",
        "https://github.com/o/r/pull/12abc",
        "https://github.com/o/r/pull/",
        "https://github.com/o/r/pull",
        "https://github.com/o/r/issues/12",
        "https://github.com/o/r/pulls/12",
        "https://github.com//r/pull/12",
        "https://github.com/o/r+x/pull/12",
        "https://github.com/o/r/x/pull/12",
        "http://github.com/o/r/pull/12",
        "https://gitlab.com/o/r/pull/12",
        "https://github.com.evil/o/r/pull/12",
        "https://example.com/pr/1#r1",
        "supersedes: decision-aaaaaaaaaa",
        42,
    ]);
    assert_eq!(
        pulls(links.as_array().unwrap()),
        [
            p("owner/repo", 7),
            p("owner/repo", 8),
            p("o.w_n-er/r.e_p-o", 9),
            p("o/r", 10),
            p("o/r", 123_456_789),
        ]
    );
}

#[test]
fn a_pull_request_is_of_this_repository_when_origin_names_it_over_https_or_ssh() {
    let t = tempfile::tempdir().unwrap();
    let d = t.path();
    let date = "2026-05-01T00:00:00+0000";
    at(d, date, &["init", "-q", "-b", "main"]);
    let links = [p("else/repo", 1), p("owner/repo", 2), p("owner/repo", 3)];
    assert_eq!(Repo::new(d).ours(&links), None, "no origin");
    at(
        d,
        date,
        &["remote", "add", "origin", "https://github.com/owner/repo"],
    );
    for (url, ours) in [
        ("https://github.com/owner/repo", Some(2)),
        ("https://github.com/Owner/Repo.git", Some(2)),
        ("git@github.com:owner/repo.git", Some(2)),
        ("git@GitHub.com:OWNER/repo", Some(2)),
        ("ssh://git@github.com/owner/repo.git", Some(2)),
        ("https://github.com/else/repo", Some(1)),
        ("https://github.com/owner/repo2", None),
        ("https://github.com/owner/repo/", Some(2)),
        ("https://github.com/owner/repo.git/", Some(2)),
        (
            "https://x-access-token:t0k@github.com/owner/repo.git",
            Some(2),
        ),
        ("https://user@github.com/owner/repo", Some(2)),
        ("https://a@b@github.com/owner/repo", Some(2)),
        ("https://user@gitlab.com/owner/repo", None),
        ("https://github.com/owner/repo//", None),
        ("git@github-work:owner/repo.git", None),
        ("https://www.github.com/owner/repo", None),
        ("https://github.com/owner/repo.git.git", None),
        ("https://gitlab.com/owner/repo", None),
        ("owner/repo", None),
    ] {
        at(d, date, &["remote", "set-url", "origin", url]);
        let got = Repo::new(d).ours(&links).map(|p| p.number);
        assert_eq!(got, ours, "{url}");
    }
    // A repository named with `.git` in it is matched by its own name.
    at(
        d,
        date,
        &["remote", "set-url", "origin", "git@github.com:o/x.git"],
    );
    assert_eq!(
        Repo::new(d).ours(&[p("o/x.git", 4)]).map(|p| p.number),
        Some(4)
    );
    assert_eq!(Repo::new(d).ours(&[p("o/x", 5)]).map(|p| p.number), Some(5));
}
