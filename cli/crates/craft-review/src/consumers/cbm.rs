//! The code graph as the binary asks it: `codebase-memory-mcp cli --quiet <tool> '<json>'`, one
//! process per question, its payload JSON on stdout (`"format": "json"`), bounded in time
//! (realm @nick/craft, node #529). Never indexes: an index older than the review's base is
//! named, with the command that refreshes it.

use std::process::Command;
use std::time::Duration;

use serde_json::{Value, json};

mod callers;
mod probe;
mod query;
mod run;

use run::{bounded, last_line};

pub use probe::{probe, refresh_hint, roots_of, said};

/// The program `craft init` asks.
pub const TOOL: &str = "codebase-memory-mcp";
/// How long one question may run.
const TIMEOUT: Duration = Duration::from_secs(30);
/// How long the callers of all a review's symbols may take, past which the rest are not asked.
const CALLERS_BUDGET: Duration = Duration::from_secs(90);
/// How many caller rows one symbol's query keeps.
pub(super) const ROWS_PER_SYMBOL: usize = 50;

/// One caller the graph names: the called symbol, the file it is defined in, and the calling
/// function's file and line span.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Caller {
    pub symbol: String,
    pub defined_in: String,
    pub file: String,
    pub start: u32,
    pub end: u32,
}

/// The graph's callers of a review's symbols, and the symbols whose callers were cut at
/// [`ROWS_PER_SYMBOL`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Asked {
    pub callers: Vec<Caller>,
    pub truncated: Vec<String>,
    /// The symbols whose callers were not asked, each with why: `name (why)`.
    pub unasked: Vec<String>,
}

/// What `index_status` says of a ready project: when it was indexed (`indexed_at`, UTC, as the
/// graph prints it) and the root it indexes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Index {
    pub at: String,
    pub root: String,
}

/// The graph's program, asked within a time bound.
#[derive(Debug, Clone)]
pub struct Cbm {
    pub tool: String,
    /// How long one question may run.
    pub timeout: Duration,
    /// How long the callers of all a review's symbols may take.
    pub budget: Duration,
}

impl Cbm {
    #[must_use]
    pub fn new(tool: &str) -> Self {
        Self {
            tool: tool.to_owned(),
            timeout: TIMEOUT,
            budget: CALLERS_BUDGET,
        }
    }

    /// The payload of `cli --quiet <name> <args + format json>`; why not, one line.
    fn call(&self, name: &str, mut args: Value, limit: Duration) -> Result<Value, String> {
        if let Some(o) = args.as_object_mut() {
            o.insert("format".into(), "json".into());
        }
        let mut cmd = Command::new(&self.tool);
        cmd.args(["cli", "--quiet", name, &args.to_string()]);
        let (ok, stdout, stderr) = bounded(cmd, limit)?;
        let payload: Option<Value> = serde_json::from_str(stdout.trim()).ok();
        let error = payload.as_ref().and_then(|p| p.get("error"));
        match (ok, payload.as_ref(), error) {
            (true, Some(p), None) => Ok(p.clone()),
            (_, _, Some(e)) => Err(format!("{name}: {}", e.as_str().unwrap_or("error"))),
            _ => Err(format!("{name}: {}", last_line(&stderr, &stdout))),
        }
    }

    /// The graph's project whose root is one of `roots`.
    ///
    /// # Errors
    /// When the graph does not answer.
    pub fn project_of(&self, roots: &[String]) -> Result<Option<String>, String> {
        let listed = self.call("list_projects", json!({"limit": 1000}), self.timeout)?;
        let projects = listed.get("projects").and_then(Value::as_array);
        Ok(projects.into_iter().flatten().find_map(|p| {
            let root = p.get("root_path").and_then(Value::as_str)?;
            roots.iter().any(|r| r == root).then(|| text(p.get("name")))
        }))
    }

    /// When `project` was indexed and the root it indexes, refused unless its status is `ready`.
    ///
    /// # Errors
    /// When the graph does not answer or the project is not ready.
    pub fn index(&self, project: &str) -> Result<Index, String> {
        let s = self.call("index_status", json!({"project": project}), self.timeout)?;
        let status = text(s.get("status"));
        if status != "ready" {
            return Err(format!("the index of {project} is {status:?}, not ready"));
        }
        Ok(Index {
            at: text(s.get("indexed_at")),
            root: text(s.get("root_path")),
        })
    }
}

fn text(v: Option<&Value>) -> String {
    v.and_then(Value::as_str).unwrap_or_default().to_owned()
}

/// Whether `s` is an identifier, so it can be quoted into a query as it is.
pub(super) fn is_ident(s: &str) -> bool {
    let mut cs = s.chars();
    cs.next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && cs.all(|c| c.is_ascii_alphanumeric() || c == '_')
}
