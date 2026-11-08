//! Unit mode's contract lens and the coordinator after the lens round (`contractPrompt` and
//! `seamPrompt` in `lib/review-unit-prompts.mjs`), rendered from the templates the engine renders.

use serde_json::Value;

use super::lens::{range, repo_rules_line};
use super::units::scope_head;
use super::{PromptContext, repo_directive, shq};
use crate::content::{self, ContentError, vars};
use crate::profile::{Profile, UnitWords};

/// The contract lens of the unit at `root` (realm @nick/craft, #327): its public surface and the
/// call sites of other units, never a body.
///
/// # Errors
/// When a content file is missing or a placeholder has no value.
pub fn contract_prompt(
    ctx: &PromptContext,
    profile: &Profile,
    words: &UnitWords,
    root: &str,
    prior: &str,
    repo_rules: &[String],
) -> Result<String, ContentError> {
    let r = shq(root);
    let body = content::prompt(
        "lens-contract",
        &vars([
            ("scopeHead", scope_head(&words.noun)?),
            ("noun", words.noun.clone()),
            ("root", r.clone()),
            ("lang", profile.lang.clone()),
            ("range", range(ctx)),
            ("priorSummary", prior.to_owned()),
            (
                "surface",
                content::render(&words.surface, &vars([("root", r)]))?,
            ),
            ("publicItems", words.public_items.clone()),
            (
                "exclude",
                if root == "." {
                    String::new()
                } else {
                    format!(" ':!{root}'")
                },
            ),
            ("repoRules", repo_rules_line(repo_rules)?),
        ]),
    )?;
    Ok(format!("{}{body}", repo_directive(&ctx.repo)))
}

/// The coordinator after the lens round (the engine's seam pass; realm @nick/craft, #315, #321): the
/// integration between the touched units, the questions the lenses left open, and a disposition for
/// each finding one of them names.
///
/// # Errors
/// When a content file is missing or a placeholder has no value.
pub fn seam_prompt(
    ctx: &PromptContext,
    profile: &Profile,
    words: &UnitWords,
    units: &[String],
    open: &[Value],
    repo_rules: &[String],
) -> Result<String, ContentError> {
    let body = content::prompt(
        "seam",
        &vars([
            ("lang", profile.lang.clone()),
            ("noun", words.noun.clone()),
            (
                "units",
                units
                    .iter()
                    .map(|u| format!("`{u}`"))
                    .collect::<Vec<_>>()
                    .join(", "),
            ),
            ("range", range(ctx)),
            ("changedItems", words.changed_items.clone()),
            ("open", Value::Array(open.to_vec()).to_string()),
            ("repoRules", repo_rules_line(repo_rules)?),
        ]),
    )?;
    Ok(format!("{}{body}", repo_directive(&ctx.repo)))
}
