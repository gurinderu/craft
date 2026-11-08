//! The scout's prompt (`scoutPrompt` in `lib/review-lens-prompts.mjs`) and the dedup pass's
//! (`dedupModelGroups` in `lib/review-dedup.mjs`).

use serde_json::Value;

use super::{PromptContext, flatten, repo_directive, shq};
use crate::content::{self, ContentError, vars};
use crate::plan::REPO_RULES_MAX;
use crate::profile::Profile;

/// How much of a finding's `why` the dedup listing carries.
const DEDUP_WHY_MAX: usize = 160;

/// The scout's prompt for `profile`'s part `files` of the diff: classify it and pick the lenses,
/// without reviewing it.
///
/// # Errors
/// When a content file is missing or a placeholder has no value.
pub fn scout_prompt(
    ctx: &PromptContext,
    profile: &Profile,
    files: &[String],
) -> Result<String, ContentError> {
    let globs = profile.pathspec(files);
    let json = |v: Vec<String>| serde_json::to_string(&v).unwrap_or_default();
    let is_library = if profile.uses_library {
        "true if this is a published library (has `[lib]`/looks publishable) — best effort."
    } else {
        "always false (not applicable to this language)."
    };
    let body = content::prompt(
        "scout",
        &vars([
            ("lang", profile.lang.clone()),
            ("scope", scope_line(ctx)?),
            ("base", format!("`{}`", flatten(Some(&Value::String(ctx.base.clone()))))),
            ("globs", globs),
            ("statRange", format!("{}...HEAD", shq(&ctx.base))),
            ("lenses", json(profile.roster())),
            ("safetyLens", profile.safety_lens.clone()),
            ("securityHints", profile.security_hints.clone()),
            ("conditionalLenses", json(profile.lenses.iter().filter(|l| l.conditional).map(|l| l.id.clone()).collect())),
            ("scoutRules", content::text(&profile.scout_rules)?),
            ("strict", strict_line(ctx)?),
            ("isLibrary", is_library.into()),
            ("intent", "infer the change's purpose from the diff and any PR/commit messages; empty string if unclear.".into()),
            ("repoRulesStep", content::prompt("scout-repo-rules", &vars([("max", REPO_RULES_MAX.to_string())]))?),
        ]),
    )?;
    Ok(format!("{}{body}", repo_directive(&ctx.repo)))
}

/// The scout's SCOPE line under a scope (`path`), naming the directory it reviews; empty
/// otherwise.
fn scope_line(ctx: &PromptContext) -> Result<String, ContentError> {
    let Some(scope) = ctx.scope.as_deref() else {
        return Ok(String::new());
    };
    let dir = flatten(Some(&Value::String(scope.to_owned())));
    let line = content::prompt("scout-scope", &vars([("dir", dir), ("quoted", shq(scope))]))?;
    Ok(format!("\n\n{line}"))
}

/// The scout's STRICT MODE line, which makes it always pick `maintainability`; empty otherwise.
fn strict_line(ctx: &PromptContext) -> Result<String, ContentError> {
    if !ctx.strict {
        return Ok(String::new());
    }
    Ok(format!("\n   {}", content::text("scout-strict")?))
}

fn field<'a>(f: &'a Value, k: &str) -> &'a str {
    f.get(k).and_then(Value::as_str).unwrap_or("")
}

/// The dedup pass's prompt over `pool`, each finding listed by its index.
///
/// # Errors
/// When a content file is missing or a placeholder has no value.
pub fn dedup_prompt(ctx: &PromptContext, pool: &[Value]) -> Result<String, ContentError> {
    let listing = pool
        .iter()
        .enumerate()
        .map(|(i, f)| {
            let file = field(f, "file");
            let line = f.get("line").and_then(Value::as_i64).unwrap_or(0);
            let why: String = field(f, "why").chars().take(DEDUP_WHY_MAX).collect();
            format!(
                "{i}. {}:{line} [{}] ({}) {} — {why}",
                if file.is_empty() { "?" } else { file },
                field(f, "severity"),
                field(f, "source"),
                field(f, "title"),
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let body = content::prompt("dedup", &vars([("listing", listing)]))?;
    Ok(format!("{}{body}", repo_directive(&ctx.repo)))
}
