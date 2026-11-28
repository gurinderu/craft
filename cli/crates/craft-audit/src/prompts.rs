//! The audit's prompts: a lens over a batch of whole files, rendered from
//! `content/prompts/audit-lens.md` with the review's own parts — the lens's brief and catalogue,
//! the review rules and harm cap, the rule-id line, the dependency-source note — and the review's
//! batch verifier ([`craft_review::prompts::batch_verify_prompt`]); each written with the skill
//! files it names and the note on saying it could not look, as the review writes its tasks.

use craft_review::content::{self, ContentError, render, vars};
use craft_review::profile::{Lens, Profile};
use craft_review::prompts::{self, PromptContext};
use serde_json::Value;

use crate::batch::Tracked;
use crate::state::{AuditState, Task};

const LENS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../content/prompts/audit-lens.md"
));

/// What every prompt of the run is rendered with: its repository and where craft's files are.
#[must_use]
pub fn context(s: &AuditState) -> PromptContext {
    PromptContext {
        repo: s.cwd.display().to_string(),
        craft_root: s.args.craft_root.clone(),
        craft_version: Some(s.args.craft_version.clone()).filter(|v| !v.is_empty()),
        ..PromptContext::default()
    }
}

/// The prompt of `profile`'s lens `lens` over `files`, read whole.
///
/// # Errors
/// When a content file is missing or a placeholder has no value.
pub fn lens_prompt(
    ctx: &PromptContext,
    profile: &Profile,
    lens: &Lens,
    files: &[Tracked],
) -> Result<String, ContentError> {
    let nav = !profile.nav_skill.is_empty();
    let listed: Vec<String> = files
        .iter()
        .map(|f| format!("- `{}` ({} bytes)", f.path, f.bytes))
        .collect();
    let bytes: u64 = files.iter().map(|f| f.bytes).sum();
    let body = render(
        LENS,
        &vars([
            ("lens", lens.id.clone()),
            ("lang", profile.lang.clone()),
            ("rubricSkill", profile.rubric_of(&lens.id).to_owned()),
            (
                "navLoad",
                if nav {
                    format!(" and the {} skill for context expansion", profile.nav_skill)
                } else {
                    String::new()
                },
            ),
            ("brief", content::text(&lens.brief)?),
            ("catalogue", prompts::catalogue_line(ctx, lens)?),
            ("rules", prompts::rules(ctx)?),
            ("count", files.len().to_string()),
            ("bytes", bytes.to_string()),
            ("files", listed.join("\n")),
            ("lsp", if nav { " + LSP".into() } else { String::new() }),
            ("dependencySource", content::text("dependency-source")?),
            ("ruleId", prompts::rule_id(profile, &lens.id)?),
        ]),
    )?;
    Ok(format!(
        "{}{body}",
        prompts::work_directive(&ctx.repo, "audit")
    ))
}

/// The answer schema of a lens.
///
/// # Errors
/// When the schema cannot be read.
pub fn lens_schema() -> Result<Value, ContentError> {
    content::schema("findings")
}

/// The prompt of the verifier of `profile`'s findings `group`, each judged on its own.
///
/// # Errors
/// When a content file is missing or a placeholder has no value.
pub fn verify_prompt(
    ctx: &PromptContext,
    profile: &Profile,
    group: &[&Value],
) -> Result<String, ContentError> {
    prompts::batch_verify_prompt(ctx, profile, group)
}

/// The answer schema of a verifier.
///
/// # Errors
/// When the schema cannot be read.
pub fn verify_schema() -> Result<Value, ContentError> {
    content::schema("batch-verdict")
}

/// A task's prompt as its file holds it: its text (a retry's with why its last answer was
/// refused), the skill files it names, and the note on saying it could not look.
///
/// # Errors
/// When the note's content file is missing.
pub fn written(ctx: &PromptContext, task: &Task) -> Result<String, ContentError> {
    Ok(format!(
        "{}{}{}",
        task.prompt_text(),
        prompts::skills::block(ctx, &task.prompt),
        craft_review::blocked::note(&task.schema)?
    ))
}

#[cfg(test)]
mod tests;
