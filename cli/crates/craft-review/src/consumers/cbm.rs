//! The code graph as the binary asks it: `codebase-memory-mcp cli --quiet <tool> '<json>'`, one
//! process per question, its payload JSON on stdout (`"format": "json"`), bounded in time
//! (realm @nick/craft, node #529). Never indexes: an index older than the review's base is
//! named, and the index-warmup refreshes it.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

mod probe;

pub use probe::{probe, roots_of, said};

/// The program `craft init` asks.
pub const TOOL: &str = "codebase-memory-mcp";
/// How long one question may run.
const TIMEOUT: Duration = Duration::from_secs(30);
/// How many caller rows one query may return.
const ROWS_MAX: usize = 400;

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

    /// The functions that call any of `names` (identifiers only), by a `CALLS` edge.
    ///
    /// # Errors
    /// When the graph does not answer.
    pub fn callers(&self, project: &str, names: &[&str]) -> Result<Vec<Caller>, String> {
        let list: Vec<String> = names
            .iter()
            .filter(|n| is_ident(n))
            .map(|n| format!("'{n}'"))
            .collect();
        if list.is_empty() {
            return Ok(Vec::new());
        }
        let query = format!(
            "MATCH (c)-[r:CALLS]->(f) WHERE f.name IN [{}] RETURN f.name, f.file_path, \
             c.file_path, c.start_line, c.end_line LIMIT {ROWS_MAX}",
            list.join(", ")
        );
        let out = self.call("query_graph", json!({"project": project, "query": query}))?;
        let rows = out.get("rows").and_then(Value::as_array);
        Ok(rows.into_iter().flatten().filter_map(caller).collect())
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

fn last_line(stderr: &str, stdout: &str) -> String {
    let all = format!("{stderr}\n{stdout}");
    let line = all.lines().map(str::trim).rfind(|l| !l.is_empty());
    line.unwrap_or("no message").chars().take(200).collect()
}

/// Runs `cmd` with no stdin, its success, stdout and stderr; killed past `limit`. stdout is read
/// on its own thread, so a long answer never blocks the program on a full pipe.
fn bounded(mut cmd: Command, limit: Duration) -> Result<(bool, String, String), String> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{} could not run: {e}", cmd.get_program().display()))?;
    let pipe = |r: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut s = String::new();
            r.map(|mut r| r.read_to_string(&mut s));
            s
        })
    };
    let out = pipe(
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let err = pipe(
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let start = Instant::now();
    let status = loop {
        if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
            break s;
        }
        if start.elapsed() > limit {
            child.kill().map_err(|e| e.to_string())?;
            child.wait().map_err(|e| e.to_string())?;
            return Err(format!("no answer within {}s", limit.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let read = |h: std::thread::JoinHandle<String>| h.join().unwrap_or_default();
    Ok((status.success(), read(out), read(err)))
}
