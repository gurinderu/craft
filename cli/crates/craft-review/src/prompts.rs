//! The prompts of a review: the scout, every lens, the dedup pass and the verifiers, each rendered
//! from `content/prompts/` with the values `lib/review-lens-prompts.mjs`, `lib/review-dedup.mjs`
//! and `lib/review-verify.mjs` compute for the same template — what is chosen or joined is chosen
//! here and passed in.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::sources::Sources;

mod adjudicate;
mod lens;
#[cfg(test)]
mod parity;
mod red_team;
mod scout;
mod verify;
pub use adjudicate::{adjudicate_prompt, carry_prompt, sanitize};
pub use lens::{LensIn, lens_prompt, prior_found_summary};
pub use red_team::red_team_prompt;
pub use scout::{dedup_prompt, scout_prompt};
pub use verify::{batch_verify_prompt, verify_prompt};

/// The skill directory every lens and verifier reads beside its rubric.
const REVIEW_RULES_DIR: &str = "skills/review-rules";
/// How much of a model-authored field enters a prompt, as `flattenField` caps it.
const FIELD_MAX: usize = 500;
/// How much of the commit log stands in for the stated spec.
pub(crate) const SPEC_MAX: usize = 4000;

/// What every prompt of one run is rendered from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptContext {
    pub repo: String,
    pub base: String,
    /// The commit messages of the change, capped: the lenses' STATED SPEC block.
    pub spec: String,
    pub craft_root: Option<String>,
    pub craft_version: Option<String>,
    /// Which round of a branch's review the lenses are told this is: a first review, or a re-review
    /// of the fix commits or of the whole diff again. Optional, so a state written before it reads
    /// as a first review.
    #[serde(default, skip_serializing_if = "ReScope::is_first")]
    pub re_review: ReScope,
    /// Strict mode: the maintainability bar is a presumption of block (`strict` in
    /// `lib/review-run-args.mjs`). Optional, so a state written before it reads as a default review.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub strict: bool,
    /// The integration points' sources the run prepared, for the lenses and verifiers that read
    /// them. Optional, so a state written before it reads as a run with none.
    #[serde(default, skip_serializing_if = "Sources::is_empty")]
    pub sources: Sources,
}

/// What a round's lenses review, as `reReviewBlock` in `lib/review-lens-prompts.mjs` frames it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReScope {
    /// A first review: no prior round, no framing.
    #[default]
    First,
    /// The fix commits since the prior round's head, which `base` then names.
    Fixes,
    /// The whole diff again on a re-review: a periodic or a forced full re-scan.
    Rescan,
}

impl ReScope {
    #[must_use]
    pub fn is_first(&self) -> bool {
        *self == Self::First
    }
}

/// `s` single-quoted for a shell, as `shq` in `lib/run-logging.mjs`.
fn shq(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// A model-authored field as one prompt line: newlines flattened, trimmed, capped.
fn flatten(v: Option<&Value>) -> String {
    let s = match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    };
    let one: String = s
        .split(['\r', '\n'])
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    one.trim().chars().take(FIELD_MAX).collect()
}

/// The places a file inside craft may live, in the order an agent tries them, each in backticks.
fn plugin_candidates(ctx: &PromptContext, file: &str) -> String {
    let mut c = Vec::new();
    if let Some(root) = ctx.craft_root.as_deref().filter(|r| !r.is_empty()) {
        c.push(format!("{root}/{file}"));
    }
    c.push(format!("${{CLAUDE_PLUGIN_ROOT}}/{file}"));
    if let Some(v) = ctx.craft_version.as_deref() {
        c.push(format!(
            "${{CLAUDE_CONFIG_DIR:-$HOME/.claude}}/plugins/cache/craft/craft/{v}/{file}"
        ));
    }
    c.iter()
        .map(|p| format!("`{p}`"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Every prompt starts here: the agents run where the host session runs, not in the repository.
pub(crate) fn repo_directive(repo: &str) -> String {
    format!(
        "WORKING DIRECTORY: this review targets the repository at {} — NOT the directory you start \
         in. Before ANY git / cargo / nix / file command, `cd` there (or pass `git -C`). Every file \
         path in this review is relative to that root. If that directory does not exist or is not a \
         git repository, say so and stop rather than reviewing whatever repo you happen to be \
         sitting in.\n\n",
        shq(repo)
    )
}

/// The Claude Code plugin root `dir` is or holds: `dir` itself when its manifest is there (an installed
/// copy, or the delivery directory), else the checkout's delivery `integrations/claude-code`.
#[must_use]
pub fn plugin_root_at(dir: &Path) -> Option<PathBuf> {
    [dir.to_path_buf(), dir.join("integrations/claude-code")]
        .into_iter()
        .find(|d| d.join(".claude-plugin/plugin.json").is_file())
}

/// The craft plugin root at or above `exe`, and the plugin version its manifest names.
#[must_use]
pub fn craft_root_near(exe: &Path) -> Option<(String, Option<String>)> {
    let root = exe.ancestors().find_map(plugin_root_at)?;
    let version = std::fs::read_to_string(root.join(".claude-plugin/plugin.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|m| m.get("version").and_then(Value::as_str).map(str::to_owned));
    Some((root.display().to_string(), version))
}
