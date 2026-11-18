//! The code graph as the binary asks it: `codebase-memory-mcp cli --quiet <tool> '<json>'`, one
//! process per question, its payload JSON on stdout (`"format": "json"`), bounded in time
//! (realm @nick/craft, node #529). Never indexes: an index older than the review's base is
//! named, with the command that refreshes it.

use std::process::Command;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

mod probe;
mod run;

use run::{bounded, last_line};

pub use probe::{probe, refresh_hint, roots_of, said};

/// The program `craft init` asks.
pub const TOOL: &str = "codebase-memory-mcp";
/// How long one question may run.
const TIMEOUT: Duration = Duration::from_secs(30);
/// How long the callers of all a review's symbols may take, past which none is asked.
const CALLERS_TIMEOUT: Duration = Duration::from_secs(90);
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
}

/// The graph's program, asked within a time bound.
#[derive(Debug, Clone)]
pub struct Cbm {
    pub tool: String,
    pub timeout: Duration,
}

impl Cbm {
    #[must_use]
    pub fn new(tool: &str) -> Self {
        Self {
            tool: tool.to_owned(),
            timeout: TIMEOUT,
        }
    }

    /// The payload of `cli --quiet <name> <args + format json>`; why not, one line.
    fn call(&self, name: &str, mut args: Value) -> Result<Value, String> {
        if let Some(o) = args.as_object_mut() {
            o.insert("format".into(), "json".into());
        }
        let mut cmd = Command::new(&self.tool);
        cmd.args(["cli", "--quiet", name, &args.to_string()]);
        let (ok, stdout, stderr) = bounded(cmd, self.timeout)?;
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
        let listed = self.call("list_projects", json!({"limit": 1000}))?;
        let projects = listed.get("projects").and_then(Value::as_array);
        Ok(projects.into_iter().flatten().find_map(|p| {
            let root = p.get("root_path").and_then(Value::as_str)?;
            roots.iter().any(|r| r == root).then(|| text(p.get("name")))
        }))
    }

    /// When `project` was indexed (`indexed_at`, UTC, as the graph prints it), refused unless its
    /// status is `ready`.
    ///
    /// # Errors
    /// When the graph does not answer or the project is not ready.
    pub fn indexed_at(&self, project: &str) -> Result<String, String> {
        let s = self.call("index_status", json!({"project": project}))?;
        let status = text(s.get("status"));
        if status != "ready" {
            return Err(format!("the index of {project} is {status:?}, not ready"));
        }
        Ok(text(s.get("indexed_at")))
    }

    /// The functions that call each of `names` (identifiers only), by a `CALLS` edge, one query
    /// per name, each kept to [`ROWS_PER_SYMBOL`] rows; refused past [`CALLERS_TIMEOUT`].
    ///
    /// # Errors
    /// When the graph does not answer.
    pub fn callers(&self, project: &str, names: &[&str]) -> Result<Asked, String> {
        let mut out = Asked::default();
        let start = Instant::now();
        for name in names.iter().filter(|n| is_ident(n)) {
            if start.elapsed() > CALLERS_TIMEOUT {
                return Err(format!(
                    "query_graph: the callers took over {}s",
                    CALLERS_TIMEOUT.as_secs()
                ));
            }
            let query = format!(
                "MATCH (c)-[r:CALLS]->(f) WHERE f.name = '{name}' RETURN f.name, f.file_path, \
                 c.file_path, c.start_line, c.end_line LIMIT {}",
                ROWS_PER_SYMBOL + 1
            );
            let args = json!({"project": project, "query": query, "max_rows": ROWS_PER_SYMBOL});
            let answer = self.call("query_graph", args)?;
            let rows = answer.get("rows").and_then(Value::as_array);
            let rows: Vec<Caller> = rows.into_iter().flatten().filter_map(caller).collect();
            let flag = |k: &str| answer.get(k).and_then(Value::as_bool) == Some(true);
            if flag("has_more") || flag("truncated") || rows.len() > ROWS_PER_SYMBOL {
                out.truncated.push((*name).to_owned());
            }
            out.callers.extend(rows.into_iter().take(ROWS_PER_SYMBOL));
        }
        Ok(out)
    }
}

/// One `query_graph` row as a [`Caller`]; the graph prints numbers as strings.
fn caller(row: &Value) -> Option<Caller> {
    let cell = |i: usize| row.get(i);
    let num = |i: usize| -> Option<u32> {
        let v = cell(i)?;
        v.as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .or_else(|| v.as_str()?.parse().ok())
    };
    Some(Caller {
        symbol: cell(0)?.as_str()?.to_owned(),
        defined_in: cell(1)?.as_str()?.to_owned(),
        file: cell(2)?.as_str()?.to_owned(),
        start: num(3)?,
        end: num(4)?,
    })
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
