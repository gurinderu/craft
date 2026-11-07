//! The checks a system's source passes before git runs, as `lib/external-source-spec.mjs` makes
//! them (realm @nick/craft, node #430): its name, its repository URL and the revision, and the
//! cache directory they give.

/// How many systems one review prepares; past it they are named and dropped.
pub const SYSTEMS_MAX: usize = 8;
/// The bound of a revision.
const REF_MAX: usize = 128;

/// Whether `s` is a system name: what the report and the prompts print and a finding's
/// `externalSystem` matches (`SYSTEM_NAME`).
#[must_use]
pub fn is_system_name(s: &str) -> bool {
    let mut chars = s.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && s.len() <= 64
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// A repository's host and path, as the cache keys it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoParts {
    pub host: String,
    pub path: String,
}

fn host_ok(h: &str) -> bool {
    h.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && h.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
}

fn path_ok(p: &str) -> bool {
    !p.is_empty()
        && p.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '~' | '/' | '-'))
}

fn user_ok(u: &str) -> bool {
    !u.is_empty()
        && u.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// `host[:port]`, the port 1..5 digits: its host.
fn authority(a: &str) -> Option<&str> {
    let Some((host, port)) = a.split_once(':') else {
        return host_ok(a).then_some(a);
    };
    let port_ok = !port.is_empty() && port.len() <= 5 && port.chars().all(|c| c.is_ascii_digit());
    (port_ok && host_ok(host)).then_some(host)
}

/// The host and path of an `https://`, `ssh://` or `user@host:path` URL, before the path checks.
fn split_url(url: &str) -> Option<(&str, &str)> {
    if let Some(rest) = url.strip_prefix("https://") {
        let (auth, path) = rest.split_once('/')?;
        return Some((authority(auth)?, path));
    }
    if let Some(rest) = url.strip_prefix("ssh://") {
        let (auth, path) = rest.split_once('/')?;
        let auth = match auth.split_once('@') {
            Some((user, host)) if user_ok(user) => host,
            Some(_) => return None,
            None => auth,
        };
        return Some((authority(auth)?, path));
    }
    let (user, rest) = url.split_once('@')?;
    let (host, path) = rest.split_once(':')?;
    let first_ok =
        path.starts_with(|c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '~'));
    (user_ok(user) && host_ok(host) && first_ok).then_some((host, path))
}

/// A repository URL the preparation clones — https://, ssh:// or git@host:path, no option-like
/// start, no whitespace, no credentials in an https URL, no `.` or `..` segment — as
/// `repoUrlParts` reads it.
///
/// # Errors
/// Why it is refused, as a line of the report.
pub fn repo_parts(url: &str) -> Result<RepoParts, String> {
    if url.is_empty() || url.starts_with('-') || url.chars().any(char::is_whitespace) {
        return Err("repo is empty, starts with \"-\" or holds whitespace".into());
    }
    let (host, path) = split_url(url)
        .filter(|(_, p)| path_ok(p))
        .ok_or("repo is not an https://, ssh:// or git@host:path URL")?;
    let path = path.strip_suffix(".git").unwrap_or(path);
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if segs.is_empty() || segs.iter().any(|s| *s == "." || *s == "..") {
        return Err("repo has no path, or a \".\" or \"..\" segment".into());
    }
    Ok(RepoParts {
        host: host.to_lowercase(),
        path: segs.join("/"),
    })
}

/// Why `rev` is not a revision the preparation fetches, `None` when it is: a tag, branch name or
/// commit in a safe charset (`refFault`). A branch passes here and is refused against the remote.
#[must_use]
pub fn ref_fault(rev: &str) -> Option<String> {
    let mut chars = rev.chars();
    let Some(first) = chars.next() else {
        return Some("no revision".into());
    };
    if rev.len() > REF_MAX {
        return Some(format!("revision over {REF_MAX} characters"));
    }
    let safe = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '/' | '-');
    if !first.is_ascii_alphanumeric() || !chars.all(safe) {
        return Some(
            "revision outside [A-Za-z0-9._+/-] or starting with a non-alphanumeric".into(),
        );
    }
    if rev.contains("..") || rev.contains("//") || rev.ends_with('/') || rev.ends_with(".lock") {
        return Some("revision with \"..\", \"//\", a trailing \"/\" or \".lock\"".into());
    }
    None
}

/// Whether `rev` is a full commit id, fetched by its id rather than by a tag name.
#[must_use]
pub fn is_commit_id(rev: &str) -> bool {
    rev.len() == 40 && rev.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
}

/// The `v` spelling of a bare version (`1.12.3` → `v1.12.3`), `None` when there is none to try.
#[must_use]
pub fn v_spelling(rev: &str) -> Option<String> {
    let v = format!("v{rev}");
    (rev.starts_with(|c: char| c.is_ascii_digit()) && ref_fault(&v).is_none()).then_some(v)
}

/// One path segment of the cache, filename-safe.
fn segment(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// The cache-relative directory of a system at a revision, `<host>/<path>@<ref>`, a `/` in the
/// revision spelled `~` (git refuses `~` in a ref name, so two revisions never share one).
#[must_use]
pub fn cache_segments(parts: &RepoParts, rev: &str) -> Vec<String> {
    let mut segs: Vec<String> = std::iter::once(parts.host.as_str())
        .chain(parts.path.split('/'))
        .map(segment)
        .collect();
    if let Some(last) = segs.last_mut() {
        last.push('@');
        last.push_str(&rev.replace('/', "~"));
    }
    segs
}
