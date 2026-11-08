//! The completeness critic's prompt and what a lens it admitted is told, as `criticPrompt` and
//! `criticPrior` in `lib/review-critic.mjs` render them; and a consumer's own agent run as an extra
//! lens, as `extraLensPrompt` in `lib/review-lens-prompts.mjs` renders it (realm @nick/craft, node
//! #295): the whole change, no profile pathspec.

use serde_json::Value;

use super::lens::{base_label, range, re_review, repo_rules_line, rules};
use super::{PromptContext, flatten, repo_directive};
use crate::content::{self, ContentError, vars};

/// What the critic of one profile is asked about.
#[derive(Debug, Clone, Copy)]
pub struct CriticIn<'a> {
    pub lang: &'a str,
    /// The lenses the plan ran.
    pub lenses: &'a [String],
    pub confirmed: usize,
    pub suspected: usize,
    /// The lenses it may name: the roster's not run.
    pub candidates: &'a [String],
}

/// The completeness critic's prompt.
///
/// # Errors
/// When the template is missing or a placeholder has no value.
pub fn critic_prompt(ctx: &PromptContext, at: &CriticIn<'_>) -> Result<String, ContentError> {
    let base = flatten(Some(&Value::String(ctx.base.clone())));
    let candidates = serde_json::to_string(at.candidates).unwrap_or_else(|_| "[]".into());
    let body = content::prompt(
        "critic",
        &vars([
            ("lang", at.lang.to_owned()),
            ("base", if base.is_empty() { "HEAD".into() } else { base }),
            ("lenses", at.lenses.join(", ")),
            ("confirmed", at.confirmed.to_string()),
            ("suspected", at.suspected.to_string()),
            ("candidates", candidates),
        ]),
    )?;
    Ok(format!("{}{body}", repo_directive(&ctx.repo)))
}

/// What a lens the critic admitted is told in place of the ALREADY-FOUND list: how many findings
/// the earlier lenses produced.
///
/// # Errors
/// When the template is missing.
pub fn critic_prior(count: usize) -> Result<String, ContentError> {
    content::prompt("critic-prior", &vars([("count", count.to_string())]))
}

/// The prompt of the consumer's agent `agent` run as an extra lens over the whole change, told
/// what the pool holds (`prior`) and the repository's rule files the first plan found.
///
/// # Errors
/// When a template is missing or a placeholder has no value.
pub fn extra_lens_prompt(
    ctx: &PromptContext,
    agent: &str,
    prior: &str,
    repo_rules: &[String],
) -> Result<String, ContentError> {
    let already = content::prompt("already-found", &vars([("summary", prior.to_owned())]))?;
    let body = content::prompt(
        "lens-extra",
        &vars([
            ("agent", agent.to_owned()),
            ("base", base_label(ctx)),
            ("range", range(ctx)),
            ("pathspec", String::new()),
            ("reReview", re_review(ctx)?),
            ("rules", rules(ctx)?),
            ("repoRules", repo_rules_line(repo_rules)?),
            ("alreadyFound", already),
        ]),
    )?;
    Ok(format!("{}{body}", repo_directive(&ctx.repo)))
}

#[cfg(test)]
#[path = "critic_parity.rs"]
mod parity;
