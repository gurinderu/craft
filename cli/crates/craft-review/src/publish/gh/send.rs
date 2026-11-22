//! Sending one defect's review comment through a request file in the run's `publish/` directory:
//! on its line, and on its file when GitHub refuses the line.

use std::path::Path;

use serde_json::{Value, json};

use super::{Failed, gh_said};
use crate::gate::runner::Runner;
use crate::publish::Defect;

/// The request of one review comment (REST `POST /repos/{owner}/{repo}/pulls/{pr}/comments`, as
/// `findingPostRequest` builds it): on `line` when the diff changed it, else on its file.
pub(in crate::publish) fn request(file: &str, line: Option<u32>, head: &str, body: &str) -> Value {
    match line {
        Some(line) => {
            json!({"commit_id": head, "path": file, "line": line, "side": "RIGHT", "body": body})
        }
        None => json!({"commit_id": head, "path": file, "subject_type": "file", "body": body}),
    }
}

/// The pull request the comments go to, and where gh runs and keeps its request files.
pub(in crate::publish) struct To<'a> {
    pub(in crate::publish) runner: &'a Runner,
    pub(in crate::publish) repo: &'a Path,
    pub(in crate::publish) dir: &'a Path,
    pub(in crate::publish) pr: u64,
    pub(in crate::publish) head: &'a str,
}

impl To<'_> {
    /// Posts one comment through a request file named `name` in the directory.
    fn send(&self, name: &str, req: &Value) -> Result<(), Failed> {
        let file = self.dir.join(format!("{name}.json"));
        std::fs::create_dir_all(self.dir)
            .and_then(|()| std::fs::write(&file, req.to_string()))
            .map_err(|e| Failed {
                why: format!("writing {}: {e}", file.display()),
                stderr: String::new(),
            })?;
        let route = format!("repos/{{owner}}/{{repo}}/pulls/{}/comments", self.pr);
        let input = file.display().to_string();
        gh_said(
            self.runner,
            self.repo,
            &["api", "--method", "POST", &route, "--input", &input],
        )
        .map(|_| ())
    }

    /// Posts defect `n`: on its line, and on its file when GitHub refuses the line as outside the
    /// PR's diff (HTTP 422; realm @nick/craft, node #285). Says whether it went on its file so.
    pub(in crate::publish) fn defect(
        &self,
        n: usize,
        d: &Defect,
        body: &str,
    ) -> Result<bool, String> {
        let name = format!("comment-{n}");
        match self.send(&name, &request(&d.file, d.line, self.head, body)) {
            Ok(()) => Ok(false),
            Err(f) if d.line.is_some() && f.stderr.contains("HTTP 422") => self
                .send(
                    &format!("{name}-file"),
                    &request(&d.file, None, self.head, body),
                )
                .map(|()| true)
                .map_err(|f| f.why),
            Err(f) => Err(f.why),
        }
    }
}
