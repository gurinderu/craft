//! The `codex` backend: each run is one `codex exec` subprocess, ephemeral and read-only, in the
//! request's directory, its prompt on stdin; Codex writes its last message — the answer, in the
//! shape `--output-schema` holds it to — to a file of its own (realm @nick/craft, nodes #491,
//! #499). The schema it is given is a strict copy ([`schema::strict`]), and the nulls that copy
//! forced are dropped from the answer. The login is the Codex session's own; no key is passed.

pub mod schema;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde_json::Value;

use crate::{AgentBackend, AgentError, AgentReply, AgentRequest, Usage, subprocess};

/// Runs agents through `codex exec`.
#[derive(Debug, Clone)]
pub struct Codex {
    /// The CLI to run, `codex` by default.
    pub command: PathBuf,
    /// A run that takes longer is killed.
    pub timeout: Duration,
    /// Variables set for every run on top of craft's own environment.
    pub env: Vec<(String, String)>,
}

impl Default for Codex {
    fn default() -> Self {
        Self {
            command: PathBuf::from("codex"),
            timeout: Duration::from_secs(2 * 60 * 60),
            env: Vec::new(),
        }
    }
}

/// The files one run hands Codex: the strict schema and where its last message goes, in a
/// directory of their own, removed when the run ends.
struct Scratch {
    dir: PathBuf,
}

impl Scratch {
    fn new() -> std::io::Result<Self> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("craft-codex-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir)?;
        Ok(Self { dir })
    }

    fn schema(&self) -> PathBuf {
        self.dir.join("schema.json")
    }

    fn answer(&self) -> PathBuf {
        self.dir.join("answer.json")
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        // Left behind only in the temporary directory, where it harms nothing.
        let _gone = std::fs::remove_dir_all(&self.dir);
    }
}

impl Codex {
    /// The argv for one run: the schema file when the request has a schema, the last message to
    /// `answer`; the prompt goes on stdin (`-`).
    #[must_use]
    pub fn argv(request: &AgentRequest, schema: Option<&Path>, answer: &Path) -> Vec<String> {
        let mut argv: Vec<String> = ["exec", "--ephemeral", "-s", "read-only"]
            .map(String::from)
            .into();
        if let Some(schema) = schema {
            argv.push("--output-schema".into());
            argv.push(schema.display().to_string());
        }
        argv.extend([
            "-o".into(),
            answer.display().to_string(),
            "-C".into(),
            request.cwd.display().to_string(),
        ]);
        if let Some(model) = &request.model {
            argv.push("-m".into());
            argv.push(model.clone());
        }
        argv.push("-".into());
        argv
    }

    async fn exec(&self, request: &AgentRequest, scratch: &Scratch) -> Result<(), AgentError> {
        let schema = match &request.schema {
            Some(s) => {
                std::fs::write(scratch.schema(), schema::strict(s).to_string())?;
                Some(scratch.schema())
            }
            None => None,
        };
        let argv = Self::argv(request, schema.as_deref(), &scratch.answer());
        let spawn = subprocess::Spawn {
            program: &self.command,
            args: &argv,
            cwd: &request.cwd,
            env: &self.env,
            stdin: request.prompt.as_bytes(),
        };
        let output = tokio::time::timeout(self.timeout, subprocess::output(spawn))
            .await
            .map_err(|_elapsed| AgentError::TimedOut(self.timeout))??;
        if !output.status.success() {
            return Err(subprocess::quit(&output));
        }
        if scratch.answer().exists() {
            Ok(())
        } else {
            Err(subprocess::no_answer(&output))
        }
    }
}

/// The reply from the last message Codex wrote: the answer with its forced nulls dropped when a
/// schema was given and it is JSON; else the text as it stands, for the caller to refuse.
fn reply_of(text: String, schema: Option<&Value>) -> AgentReply {
    let structured = schema.and_then(|s| {
        serde_json::from_str::<Value>(&text)
            .ok()
            .map(|v| schema::drop_optional_nulls(v, s))
    });
    AgentReply {
        structured,
        text: Some(text),
        // Codex prints only a total, so nothing is counted.
        usage: Usage::default(),
        cost_usd: 0.0,
        denials: Vec::new(),
    }
}

impl AgentBackend for Codex {
    async fn run(&self, request: &AgentRequest) -> Result<AgentReply, AgentError> {
        let scratch = Scratch::new()?;
        self.exec(request, &scratch).await?;
        let text = std::fs::read_to_string(scratch.answer())?;
        Ok(reply_of(text, request.schema.as_ref()))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn argv_is_read_only_and_ephemeral_with_the_model_only_when_asked() {
        let request = AgentRequest {
            label: "t".into(),
            prompt: String::new(),
            model: Some("gpt-x".into()),
            schema: None,
            allowed_tools: Vec::new(),
            cwd: PathBuf::from("/repo"),
        };
        let argv = Codex::argv(&request, Some(Path::new("/s.json")), Path::new("/a.json"));
        assert_eq!(
            argv,
            [
                "exec",
                "--ephemeral",
                "-s",
                "read-only",
                "--output-schema",
                "/s.json",
                "-o",
                "/a.json",
                "-C",
                "/repo",
                "-m",
                "gpt-x",
                "-"
            ]
        );
        let bare = AgentRequest {
            model: None,
            ..request
        };
        let argv = Codex::argv(&bare, None, Path::new("/a.json"));
        assert!(!argv.iter().any(|a| a == "-m" || a == "--output-schema"));
    }

    #[test]
    fn a_json_answer_loses_its_forced_nulls_and_other_text_stays_text() {
        let schema = json!({"type": "object", "required": ["a"], "properties": {"a": {"type": "string"}, "b": {"type": "string"}}});
        let got = reply_of(r#"{"a":"x","b":null}"#.into(), Some(&schema));
        assert_eq!(got.structured, Some(json!({"a": "x"})));
        let got = reply_of("not json".into(), Some(&schema));
        assert_eq!(got.structured, None);
        assert_eq!(got.text.as_deref(), Some("not json"));
    }
}
