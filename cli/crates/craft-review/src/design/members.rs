//! Which of a tree's `Cargo.toml` files are its workspace's members: the root manifest's
//! `[workspace] members` globs less its `exclude` ones, and the root package itself. A tree whose
//! root manifest is missing or unreadable counts every manifest, as before a workspace was read.

use std::path::Path;
use std::time::{Duration, Instant};

use toml::Table;

use crate::git;

/// Whether `path`, `/`-separated, matches the Cargo glob `pat`: `*` and `?` within one segment,
/// `**` across any number of them.
pub(crate) fn glob(pat: &str, path: &str) -> bool {
    let (p, s): (Vec<&str>, Vec<&str>) = (
        pat.trim_end_matches('/').split('/').collect(),
        path.split('/').collect(),
    );
    segments(&p, &s)
}

fn segments(p: &[&str], s: &[&str]) -> bool {
    match (p.split_first(), s.split_first()) {
        (None, None) => true,
        (Some((&"**", rest)), _) => {
            segments(rest, s) || s.split_first().is_some_and(|(_, more)| segments(p, more))
        }
        (Some((head, rest)), Some((seg, more))) => segment(head, seg) && segments(rest, more),
        _ => false,
    }
}

fn segment(p: &str, s: &str) -> bool {
    let (p, s): (Vec<char>, Vec<char>) = (p.chars().collect(), s.chars().collect());
    chars(&p, &s)
}

fn chars(p: &[char], s: &[char]) -> bool {
    match (p.split_first(), s.split_first()) {
        (None, None) => true,
        (Some(('*', rest)), _) => {
            chars(rest, s) || s.split_first().is_some_and(|(_, more)| chars(p, more))
        }
        (Some(('?', rest)), Some((_, more))) => chars(rest, more),
        (Some((c, rest)), Some((d, more))) => c == d && chars(rest, more),
        _ => false,
    }
}

fn patterns(ws: &Table, key: &str) -> Vec<String> {
    ws.get(key)
        .and_then(toml::Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(toml::Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// The member manifests among `paths` (every tracked `Cargo.toml`), the root manifest's text
/// `root` saying which.
fn of<'a>(root: Option<&str>, paths: &[&'a str]) -> Vec<&'a str> {
    let Some(root) = root.and_then(|t| t.parse::<Table>().ok()) else {
        return paths.to_vec();
    };
    let package = root.contains_key("package");
    let Some(ws) = root.get("workspace").and_then(toml::Value::as_table) else {
        return paths
            .iter()
            .copied()
            .filter(|p| package && *p == "Cargo.toml")
            .collect();
    };
    let (members, exclude) = (patterns(ws, "members"), patterns(ws, "exclude"));
    paths
        .iter()
        .copied()
        .filter(|p| {
            let Some(dir) = p.strip_suffix("/Cargo.toml") else {
                return package && *p == "Cargo.toml";
            };
            members.iter().any(|m| glob(m, dir)) && !exclude.iter().any(|x| glob(x, dir))
        })
        .collect()
}

/// How long the base side's manifests may take to read.
const BASE_BUDGET: Duration = Duration::from_secs(20);

fn is_manifest(p: &str) -> bool {
    p == "Cargo.toml" || p.ends_with("/Cargo.toml")
}

/// The member manifests of the workspace in the tree: at `rev` when given (each read with `git
/// show`, within [`BASE_BUDGET`]), else the working tree's tracked ones.
pub(super) fn manifests(top: &Path, rev: Option<&str>) -> Result<Vec<String>, String> {
    let listed = match rev {
        Some(r) => git::git(top, &["ls-tree", "-r", "--name-only", r]),
        None => git::git(top, &["ls-files"]),
    }
    .map_err(|e| e.to_string())?;
    let read = |p: &str| match rev {
        Some(r) => git::git(top, &["show", &format!("{r}:{p}")]).ok(),
        None => std::fs::read_to_string(top.join(p)).ok(),
    };
    let paths: Vec<&str> = listed.lines().filter(|p| is_manifest(p)).collect();
    let root = paths
        .contains(&"Cargo.toml")
        .then(|| read("Cargo.toml"))
        .flatten();
    let started = Instant::now();
    let mut out = Vec::new();
    for p in of(root.as_deref(), &paths) {
        if rev.is_some() && started.elapsed() > BASE_BUDGET {
            return Err(format!(
                "the base's manifests took over {} s to read",
                BASE_BUDGET.as_secs()
            ));
        }
        out.extend(read(p));
    }
    Ok(out)
}
