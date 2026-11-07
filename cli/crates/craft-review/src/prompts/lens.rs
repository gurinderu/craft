//! A lens's prompt, as `lensPrompt` and `negativeSpacePrompt` in `lib/review-lens-prompts.mjs`
//! render it for an unsliced dispatch, and the ALREADY-FOUND list a later round carries
//! (`priorFoundSummary` in `lib/review-coverage.mjs`).

use serde_json::Value;

use super::{
    PromptContext, REVIEW_RULES_DIR, ReScope, flatten, plugin_candidates, repo_directive, shq,
};
use crate::content::{self, ContentError, vars};
use crate::plan::Plan;
use crate::profile::{Lens, Profile};
use crate::sources;

/// How long the ALREADY-FOUND list may grow, and how much of a title it carries.
const PRIOR_SUMMARY_MAX_CHARS: usize = 2500;
const PRIOR_SUMMARY_TITLE_MAX: usize = 120;

fn sev_rank(f: &Value) -> usize {
    let sev = f.get("severity").and_then(Value::as_str).unwrap_or("");
    ["critical", "high", "medium", "low", "info"]
        .iter()
        .position(|s| *s == sev.trim().to_lowercase())
        .unwrap_or(9)
}

fn one_line(v: Option<&Value>) -> String {
    let s = v.and_then(Value::as_str).unwrap_or("");
    s.split(['\r', '\n'])
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_owned()
}

/// What the pool holds so far, worst first, one `file:line title` a line, capped; `none yet` when
/// empty.
#[must_use]
pub fn prior_found_summary(pool: &[Value]) -> String {
    if pool.is_empty() {
        return "none yet".into();
    }
    let mut ordered: Vec<(usize, &Value)> = pool.iter().enumerate().collect();
    ordered.sort_by_key(|&(i, f)| (sev_rank(f), i));
    let lines: Vec<String> = ordered
        .iter()
        .map(|(_, f)| {
            let file = one_line(f.get("file"));
            let line = f.get("line").and_then(Value::as_i64).unwrap_or(0);
            let title: String = one_line(f.get("title"))
                .chars()
                .take(PRIOR_SUMMARY_TITLE_MAX)
                .collect();
            format!(
                "{}:{line} {title}",
                if file.is_empty() { "?" } else { &file }
            )
            .trim_end()
            .to_owned()
        })
        .collect();
    let mut kept: Vec<String> = Vec::new();
    let mut used = 0;
    for l in &lines {
        let len = l.chars().count();
        if !kept.is_empty() && used + len + 1 > PRIOR_SUMMARY_MAX_CHARS {
            break;
        }
        kept.push(l.clone());
        used += len + 1;
    }
    let omitted = lines.len() - kept.len();
    if omitted > 0 {
        kept.push(format!("… and {omitted} more already-found finding(s), lowest severity first, withheld to keep this prompt small. This list is PARTIAL: anything you re-surface is de-duplicated downstream, so do not spend effort guessing what is missing from it."));
    }
    kept.join("\n")
}

fn base_label(ctx: &PromptContext) -> String {
    format!("`{}`", flatten(Some(&Value::String(ctx.base.clone()))))
}

fn range(ctx: &PromptContext) -> String {
    format!("--merge-base {}", shq(&ctx.base))
}

fn rules(ctx: &PromptContext) -> Result<String, ContentError> {
    content::prompt(
        "review-rules",
        &vars([("dirs", plugin_candidates(ctx, REVIEW_RULES_DIR))]),
    )
}

fn repo_rules_line(paths: &[String]) -> Result<String, ContentError> {
    if paths.is_empty() {
        return Ok(String::new());
    }
    let paths = paths
        .iter()
        .map(|p| format!("`{p}`"))
        .collect::<Vec<_>>()
        .join(", ");
    content::prompt("repo-rules-line", &vars([("paths", paths)]))
}

fn intent_line(intent: &str) -> String {
    if intent.is_empty() {
        String::new()
    } else {
        format!("INTENT (what the change should do): {intent}")
    }
}

/// The plan's lines of a lens prompt: intent, spec, hot files, repository rules — one line each.
fn plan_lines(plan: &Plan) -> Result<String, ContentError> {
    let spec = if plan.spec.is_empty() {
        String::new()
    } else {
        content::prompt("lens-spec", &vars([("spec", plan.spec.clone())]))?
    };
    let hot = if plan.churn.is_empty() {
        String::new()
    } else {
        format!("HOT FILES (scrutinize harder): {}", plan.churn.join(", "))
    };
    Ok(format!(
        "{}\n{spec}\n{hot}\n{}",
        intent_line(&plan.intent),
        repo_rules_line(&plan.repo_rules)?
    ))
}

fn catalogue_line(ctx: &PromptContext, lens: &Lens) -> Result<String, ContentError> {
    let Some(cat) = &lens.catalogue else {
        return Ok(String::new());
    };
    content::prompt(
        "lens-catalogue",
        &vars([
            ("label", cat.label.clone()),
            ("candidates", plugin_candidates(ctx, &cat.file)),
            ("fallback", cat.fallback.clone()),
        ]),
    )
}

/// What one lens dispatch is rendered from: the lens of `profile`, its plan, the pathspec of the
/// profile's part of the diff, and the pool summed up as `prior`.
#[derive(Debug, Clone, Copy)]
pub struct LensIn<'a> {
    pub profile: &'a Profile,
    pub lens: &'a str,
    pub plan: &'a Plan,
    pub pathspec: &'a str,
    pub prior: &'a str,
}

/// The prompt of a lens over its profile's part of the diff in a round.
///
/// # Errors
/// When the lens is not the profile's, a content file is missing or a placeholder has no value.
pub fn lens_prompt(ctx: &PromptContext, at: &LensIn<'_>) -> Result<String, ContentError> {
    let LensIn {
        profile,
        lens,
        plan,
        ..
    } = *at;
    let spec = profile
        .lens(lens)
        .ok_or_else(|| ContentError::UnknownFile(format!("the lens {lens}")))?;
    let already = content::prompt("already-found", &vars([("summary", at.prior.to_owned())]))?;
    let body = if lens == "negative-space" {
        negative_space(ctx, profile, plan, already)?
    } else {
        let nav = !profile.nav_skill.is_empty();
        let mutants = profile.id == "rust"
            && lens == "tests"
            && matches!(plan.size_bucket.as_str(), "medium" | "large");
        content::prompt(
            "lens",
            &vars([
                ("lens", lens.to_owned()),
                ("lang", profile.lang.clone()),
                ("rubricSkill", profile.rubric_skill.clone()),
                (
                    "navLoad",
                    if nav {
                        format!(" and the {} skill for context expansion", profile.nav_skill)
                    } else {
                        String::new()
                    },
                ),
                ("brief", content::text(&spec.brief)?),
                ("catalogue", catalogue_line(ctx, spec)?),
                ("rules", rules(ctx)?),
                ("strict", strict_line(ctx, lens)?),
                ("base", base_label(ctx)),
                ("range", range(ctx)),
                ("pathspec", at.pathspec.to_owned()),
                ("slice", String::new()),
                ("reReview", re_review(ctx)?),
                ("plan", plan_lines(plan)?),
                ("lsp", if nav { " + LSP".into() } else { String::new() }),
                ("dependencySource", content::text("dependency-source")?),
                ("sources", sources_line(ctx, profile, lens)),
                ("ruleId", rule_id(profile)?),
                (
                    "mutants",
                    if mutants {
                        content::text("lens-mutants")?
                    } else {
                        String::new()
                    },
                ),
                ("alreadyFound", already),
            ]),
        )?
    };
    Ok(format!("{}{body}", repo_directive(&ctx.repo)))
}

/// The external sources' block on a line of its own, for a lens that judges another system's
/// behaviour (`sourcesLine`); empty otherwise.
fn sources_line(ctx: &PromptContext, profile: &Profile, lens: &str) -> String {
    let block = sources::lens_block(&ctx.sources.prepared);
    if block.is_empty() || !sources::reads(&profile.id, lens) {
        return String::new();
    }
    format!("\n{block}")
}

/// The maintainability lens's STRICT MODE brief, which overrides the harm cap; empty otherwise.
fn strict_line(ctx: &PromptContext, lens: &str) -> Result<String, ContentError> {
    if !ctx.strict || lens != "maintainability" {
        return Ok(String::new());
    }
    Ok(format!(
        "\n{}\n",
        content::text("lens-strict-maintainability")?
    ))
}

/// The re-review framing of a lens prompt, empty on a first review.
fn re_review(ctx: &PromptContext) -> Result<String, ContentError> {
    let name = match ctx.re_review {
        ReScope::First => return Ok(String::new()),
        ReScope::Fixes => "lens-re-review-fixes",
        ReScope::Rescan => "lens-re-review-rescan",
    };
    let base = flatten(Some(&Value::String(ctx.base.clone())));
    content::prompt(name, &vars([("base", base)]))
}

/// The lens prompt's RULE ID line: cite the rubric's catalog, or, a profile with none, leave it
/// empty.
fn rule_id(profile: &Profile) -> Result<String, ContentError> {
    if profile.rule_catalog {
        content::prompt(
            "lens-rule-id",
            &vars([("rubricSkill", profile.rubric_skill.clone())]),
        )
    } else {
        content::text("lens-rule-id-none")
    }
}

/// The negative-space lens: the bug the diff enables in code it did not touch.
fn negative_space(
    ctx: &PromptContext,
    profile: &Profile,
    plan: &Plan,
    already: String,
) -> Result<String, ContentError> {
    let surface = profile.negative_space.as_ref().ok_or_else(|| {
        ContentError::UnknownFile(format!("the negative-space surface of {}", profile.id))
    })?;
    let spec = if plan.spec.is_empty() {
        String::new()
    } else {
        content::prompt(
            "lens-negative-space-spec",
            &vars([("spec", plan.spec.clone())]),
        )?
    };
    let nav_use = if profile.nav_skill.is_empty() {
        "Use".to_owned()
    } else {
        format!(
            "Load the {} skill for whole-repo search; use",
            profile.nav_skill
        )
    };
    content::prompt(
        "lens-negative-space",
        &vars([
            ("lang", profile.lang.clone()),
            ("navUse", nav_use),
            ("base", base_label(ctx)),
            ("intent", intent_line(&plan.intent)),
            ("spec", spec),
            ("range", range(ctx)),
            ("newSurface", surface.new_surface.clone()),
            ("shapeUses", surface.shape_uses.clone()),
            ("rules", rules(ctx)?),
            ("repoRules", repo_rules_line(&plan.repo_rules)?),
            ("alreadyFound", already),
            ("rubricSkill", profile.rubric_skill.clone()),
        ]),
    )
}
