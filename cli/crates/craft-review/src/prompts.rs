//! The prompts of the slice: the Rust correctness lens and its verifiers, each rendered from
//! `content/prompts/` with the values `lib/review-lens-prompts.mjs` and `lib/review-verify.mjs`
//! compute for the same template — what is chosen or joined is chosen here and passed in.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::content::{self, ContentError, vars};

mod verify;
pub use verify::{batch_verify_prompt, verify_prompt};

/// The lens this slice runs: the Rust profile's `intent` brief, the one that judges whether the
/// change does what it is supposed to (correct-looking code with wrong behaviour, off-by-one,
/// missed requirements, false claims in comments and tests).
pub const LENS: &str = "intent";
pub const LENS_BRIEF: &str = "lens-briefs/rust-intent";
/// The review rubric skill of the Rust profile, and the exclusion catalogue it ships.
const RUBRIC_SKILL: &str = "rust-review";
const FP_RULES: &str = "fp-rules.md";
/// The diff the Rust profile reviews.
const PATHSPEC: &str = "'*.rs'";
/// The skill directory every lens and verifier reads beside its rubric.
const REVIEW_RULES_DIR: &str = "skills/review-rules";
/// How much of a model-authored field enters a prompt, as `flattenField` caps it.
const FIELD_MAX: usize = 500;
/// How much of the commit log stands in for the stated spec.
const SPEC_MAX: usize = 4000;

/// What every prompt of one run is rendered from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptContext {
    pub repo: String,
    pub base: String,
    /// The commit messages of the change: the lens's STATED SPEC block.
    pub spec: String,
    pub craft_root: Option<String>,
    pub craft_version: Option<String>,
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
fn repo_directive(repo: &str) -> String {
    format!(
        "WORKING DIRECTORY: this review targets the repository at {} — NOT the directory you start \
         in. Before ANY git / cargo / nix / file command, `cd` there (or pass `git -C`). Every file \
         path in this review is relative to that root. If that directory does not exist or is not a \
         git repository, say so and stop rather than reviewing whatever repo you happen to be \
         sitting in.\n\n",
        shq(repo)
    )
}

/// The lens prompt.
///
/// # Errors
/// When a content file is missing or a placeholder has no value.
pub fn lens_prompt(ctx: &PromptContext) -> Result<String, ContentError> {
    let spec = ctx.spec.chars().take(SPEC_MAX).collect::<String>();
    let spec = if spec.is_empty() {
        String::new()
    } else {
        content::prompt("lens-spec", &vars([("spec", spec)]))?
    };
    let rules = content::prompt(
        "review-rules",
        &vars([("dirs", plugin_candidates(ctx, REVIEW_RULES_DIR))]),
    )?;
    let base = flatten(Some(&Value::String(ctx.base.clone())));
    let body = content::prompt(
        "lens",
        &vars([
            ("lens", LENS.into()),
            ("lang", "Rust".into()),
            ("rubricSkill", RUBRIC_SKILL.into()),
            (
                "navLoad",
                " and the rust-navigation skill for context expansion".into(),
            ),
            ("brief", content::text(LENS_BRIEF)?),
            ("catalogue", String::new()),
            ("rules", rules),
            ("strict", String::new()),
            ("base", format!("`{base}`")),
            ("range", format!("--merge-base {}", shq(&ctx.base))),
            ("pathspec", PATHSPEC.into()),
            ("slice", String::new()),
            ("reReview", String::new()),
            // lensPlanLines: intent, spec, hot files, repository rules — one line each.
            ("plan", format!("\n{spec}\n\n")),
            ("lsp", " + LSP".into()),
            ("dependencySource", content::text("dependency-source")?),
            ("sources", String::new()),
            ("mutants", String::new()),
            ("alreadyFound", String::new()),
        ]),
    )?;
    Ok(format!("{}{body}", repo_directive(&ctx.repo)))
}

/// The craft checkout above `exe`, and the plugin version its manifest names.
#[must_use]
pub fn craft_root_near(exe: &Path) -> Option<(String, Option<String>)> {
    let root = exe
        .ancestors()
        .find(|d| d.join(".claude-plugin/plugin.json").is_file())?;
    let version = std::fs::read_to_string(root.join(".claude-plugin/plugin.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|m| m.get("version").and_then(Value::as_str).map(str::to_owned));
    Some((root.display().to_string(), version))
}
