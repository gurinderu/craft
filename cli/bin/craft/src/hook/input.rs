//! Whether a Bash call opened a pull request, read from Claude Code's `PostToolUse` input as
//! observed in Claude Code 2.1.319: `{session_id, transcript_path, cwd, hook_event_name, tool_name,
//! tool_input, tool_response, tool_use_id, duration_ms}`, Bash's `tool_response` its output
//! `{stdout, stderr, interrupted, …}`. No shell is parsed: a command whose text says `pr create` or
//! `pr new` and whose output holds a pull request's URL opened that PR. A miss stays silent; a
//! false hit only asks GitHub about a PR that exists.

use std::path::PathBuf;

use serde_json::Value;

#[derive(Debug)]
pub enum Input {
    /// Not a PR this call opened.
    Silent,
    /// The PR at `url`, opened from `cwd` (none when the input names none).
    Opened { url: String, cwd: Option<PathBuf> },
    /// The input may tell of a PR but could not be read, and why.
    Unreadable(String),
}

/// What the hook input `stdin` tells.
pub fn read(stdin: &str) -> Input {
    let parsed: Value = match serde_json::from_str(stdin) {
        Ok(v) => v,
        Err(e) if stdin.contains("/pull/") => {
            return Input::Unreadable(format!("the hook input is not JSON ({e})"));
        }
        Err(_) => return Input::Silent,
    };
    let command = parsed
        .pointer("/tool_input/command")
        .and_then(Value::as_str);
    let opens = command.is_some_and(|c| c.contains("pr create") || c.contains("pr new"));
    if parsed.get("tool_name").and_then(Value::as_str) != Some("Bash") || !opens {
        return Input::Silent;
    }
    let Some(url) = last_pr_url(&output(parsed.get("tool_response"))) else {
        return Input::Silent;
    };
    let cwd = parsed
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|c| !c.is_empty())
        .map(PathBuf::from);
    Input::Opened { url, cwd }
}

/// The command's output: Bash's `stdout` and `stderr`, or a response that is text as it is.
fn output(response: Option<&Value>) -> String {
    match response {
        Some(Value::String(s)) => s.clone(),
        Some(r @ Value::Object(_)) => {
            let part = |k: &str| r.get(k).and_then(Value::as_str).unwrap_or_default();
            format!("{}\n{}", part("stdout"), part("stderr"))
        }
        _ => String::new(),
    }
}

/// The last `https://<host>/<owner>/<repo>/pull/<n>` in `text`, as `gh pr create` prints it last.
fn last_pr_url(text: &str) -> Option<String> {
    text.match_indices("https://")
        .filter_map(|(at, _)| text.get(at..).and_then(pr_url))
        .last()
}

/// The PR URL `s` starts with, cut at the pull's number.
fn pr_url(s: &str) -> Option<String> {
    let rest = s.strip_prefix("https://")?;
    let mut parts = rest.splitn(5, '/');
    let (host, owner, repo) = (parts.next()?, parts.next()?, parts.next()?);
    let named = |p: &str| {
        !p.is_empty()
            && p.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    };
    if !(host.contains('.') && named(host) && named(owner) && named(repo)) {
        return None;
    }
    if parts.next()? != "pull" {
        return None;
    }
    let n: String = parts
        .next()?
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    (!n.is_empty()).then(|| format!("https://{host}/{owner}/{repo}/pull/{n}"))
}

#[cfg(test)]
#[path = "input_tests.rs"]
mod tests;
