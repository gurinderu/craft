//! What the graph says of its projects: which one indexes the repository, and how ready, fresh
//! and whole its index is.

use std::time::Instant;

use serde_json::{Value, json};

use super::{Cbm, CbmError};

/// How many projects one page of `list_projects` asks for.
const PAGE: usize = 1000;
/// How many pages are read before the listing counts as cut.
const PAGES: usize = 20;

/// What `index_status` says of a ready project: when its graph last changed (`indexed_at`, UTC, as
/// the graph prints it: an index run that finds nothing changed keeps it), the root it indexes,
/// the commit that root's HEAD names now (`git.head_sha`, empty when it names none: not the
/// commit the index was made of, which the graph does not name — the same once craft has just
/// indexed the root itself), and the files and directories (ending in `/`) it left out or could
/// not parse, relative to that root, and whether that list was cut.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Index {
    pub at: String,
    pub root: String,
    pub head: String,
    pub unindexed: Vec<String>,
    pub unindexed_cut: bool,
}

impl Index {
    /// Whether `file` (relative to the root) is one the index left out, or lies under a directory
    /// it left out.
    #[must_use]
    pub fn leaves_out(&self, file: &str) -> bool {
        self.unindexed
            .iter()
            .any(|u| u == file || (u.ends_with('/') && file.starts_with(u.as_str())))
    }
}

impl Cbm {
    /// The graph's project whose root is one of `roots`, read page by page.
    ///
    /// # Errors
    /// When the graph does not answer, or its listing is cut before it ends with no match.
    pub fn project_of(&self, roots: &[String]) -> Result<Option<String>, CbmError> {
        let mut offset = 0;
        for _ in 0..PAGES {
            let args = json!({"limit": PAGE, "offset": offset});
            let listed = self.call("list_projects", args, self.timeout)?;
            let projects = listed.get("projects").and_then(Value::as_array);
            let page = projects.map_or(&[][..], Vec::as_slice);
            if let Some(name) = page.iter().find_map(|p| named(p, roots)) {
                return Ok(Some(name));
            }
            if listed.get("has_more").and_then(Value::as_bool) != Some(true) {
                return Ok(None);
            }
            if page.is_empty() {
                break;
            }
            offset += page.len();
        }
        Err(CbmError::Graph(format!(
            "list_projects: the listing was cut after {offset} projects, none of them this repository"
        )))
    }

    /// When `project` was indexed, the root it indexes and what it left out, refused unless its
    /// status is `ready`; asked within what is left until `deadline`.
    ///
    /// # Errors
    /// When the graph does not answer in time or the project is not ready.
    pub fn index(&self, project: &str, deadline: Instant) -> Result<Index, CbmError> {
        let limit = super::left(deadline)?.min(self.timeout);
        // Without `diagnostics` the graph names how many files it left out, not which.
        let args = json!({"project": project, "verbose": true, "diagnostics": "full"});
        let s = self.call("index_status", args, limit)?;
        let status = text(s.get("status"));
        if status != "ready" {
            return Err(CbmError::Graph(format!(
                "the index of {project} is {status:?}, not ready"
            )));
        }
        let root = text(s.get("root_path"));
        let listed = [
            ("not_indexed", "files", ""),
            ("not_indexed", "dirs", "/"),
            ("parse_unusable", "files", ""),
            ("skipped", "files", ""),
        ];
        let unindexed = listed
            .iter()
            .flat_map(|&(group, kind, end)| paths(&s, group, kind, &root, end))
            .collect();
        let unindexed_cut = listed.iter().any(|&(group, _, _)| {
            s.get(group)
                .and_then(|g| g.get("truncated"))
                .and_then(Value::as_bool)
                == Some(true)
        });
        Ok(Index {
            at: text(s.get("indexed_at")),
            root,
            head: text(s.get("git").and_then(|g| g.get("head_sha"))),
            unindexed,
            unindexed_cut,
        })
    }
}

/// The name of `p`, a listed project, when its root is one of `roots`.
fn named(p: &Value, roots: &[String]) -> Option<String> {
    let root = p.get("root_path").and_then(Value::as_str)?;
    roots.iter().any(|r| r == root).then(|| text(p.get("name")))
}

/// The paths `index_status` lists under `group.kind`, each relative to `root` and ending in `end`;
/// an entry is a path, or an object naming one by `path`, `file_path` or `file`.
fn paths(s: &Value, group: &str, kind: &str, root: &str, end: &str) -> Vec<String> {
    let entries = s
        .get(group)
        .and_then(|g| g.get(kind))
        .and_then(Value::as_array);
    let path = |e: &Value| -> Option<String> {
        let p = e.as_str().or_else(|| {
            ["path", "file_path", "file"]
                .iter()
                .find_map(|k| e.get(*k).and_then(Value::as_str))
        })?;
        let rel = p
            .strip_prefix(root)
            .and_then(|r| r.strip_prefix('/'))
            .unwrap_or(p);
        let rel = rel.trim_end_matches('/');
        Some(format!("{rel}{end}"))
    };
    entries.into_iter().flatten().filter_map(path).collect()
}

fn text(v: Option<&Value>) -> String {
    v.and_then(Value::as_str).unwrap_or_default().to_owned()
}
