//! The repository `origin` names on GitHub, which a record's pull request must be of to anchor it
//! (realm @nick/craft, node #682).

/// The `owner/name` after origin's GitHub prefix, `.git` after it or not; `None` for a URL of
/// another host or form.
pub(super) fn named(url: &str) -> Option<&str> {
    let https = url.strip_prefix("https://").map(|r| {
        let host = r.find('/').map_or(r, |end| r.get(..end).unwrap_or(r));
        host.rfind('@').and_then(|at| r.get(at + 1..)).unwrap_or(r)
    });
    let rest = https
        .and_then(|r| r.strip_prefix("github.com/"))
        .or_else(|| url.strip_prefix("git@github.com:"))
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))?;
    Some(rest.strip_suffix('/').unwrap_or(rest))
}
