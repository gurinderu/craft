//! Unit mode's prompts (`lib/review-unit-prompts.mjs` and `confinedLensPrompt` in
//! `lib/review-lens-prompts.mjs`; realm @nick/craft, #316, #321, #327): a lens over a directory
//! slice, a lens confined to a unit batch, the contract lens of one unit and the seam pass — each
//! rendered from the templates the engine renders, held equal by the prompt parity cases.
//!
//! The confined lens has no blocking question: the engine's synchronous file channel, where a lens
//! waits on a file a live coordinator writes, is not ported (realm @nick/craft, #321) — in the step
//! protocol the binary does not live while a batch runs, a coordinator polling the run directory and
//! lenses waiting on it would hold the host's parallel slots against each other, other hosts share
//! no live channel, and on the #402 run the live coordinators answered nothing. Every question rides
//! in the lens's answer and reaches the coordinator after the round ([`seam_prompt`]).

use super::lens::{common_vars, lens_prompt_in, lens_spec};
use super::{LensIn, PromptContext, repo_directive, shq};
use crate::content::{self, ContentError, vars};
use crate::profile::UnitWords;
use crate::units::Slice;

/// A slice's files as literal git pathspecs, each shell-quoted (`lensPathspec`).
fn slice_pathspec(slice: &Slice) -> String {
    slice
        .files
        .iter()
        .filter(|f| !f.is_empty())
        .map(|f| shq(&format!(":(literal){f}")))
        .collect::<Vec<_>>()
        .join(" ")
}

/// The head of a confined prompt, which overrides the agent's own context steps.
pub(super) fn scope_head(noun: &str) -> Result<String, ContentError> {
    content::prompt(
        "unit-scope-head",
        &vars([("upperNoun", noun.to_uppercase())]),
    )
}

/// The unit rule of a lens confined to the units of `slice` (`unitRuleBlock` with no channel).
fn unit_rule(words: &UnitWords, units: &[String]) -> Result<String, ContentError> {
    let n = &words.noun;
    let roots = units
        .iter()
        .map(|x| {
            format!(
                "`{}`",
                if x == "." {
                    ".".into()
                } else {
                    format!("{x}/")
                }
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    let judged = match units.len() {
        0 | 1 => format!("the {n} rooted at {roots}"),
        k => format!("the {k} {n}s rooted at {roots} (one batch)"),
    };
    content::prompt(
        "unit-rule",
        &vars([
            ("scopeHead", scope_head(n)?),
            ("judged", judged),
            ("roots", roots),
            ("noun", n.clone()),
            ("signatures", words.signatures.clone()),
            ("blocking", String::new()),
            ("done", String::new()),
        ]),
    )
}

/// The prompt of a lens over one slice: confined to its units, or, a directory slice of files in
/// no unit, the lens prompt with its YOUR SLICE block.
///
/// # Errors
/// When the lens is not the profile's, a content file is missing or a placeholder has no value.
pub fn slice_lens_prompt(
    ctx: &PromptContext,
    at: &LensIn<'_>,
    slice: &Slice,
) -> Result<String, ContentError> {
    let pathspec = slice_pathspec(slice);
    let at = LensIn {
        pathspec: &pathspec,
        ..*at
    };
    let count = slice.files.len().to_string();
    let Some(words) = at
        .profile
        .units
        .as_ref()
        .filter(|_| !slice.units.is_empty())
    else {
        let block = content::prompt(
            "lens-slice",
            &vars([("key", slice.key.clone()), ("count", count)]),
        )?;
        return lens_prompt_in(ctx, &at, block);
    };
    let mut v = common_vars(ctx, &at, lens_spec(&at)?)?;
    v.extend(vars([
        ("key", slice.key.clone()),
        ("count", count),
        ("noun", words.noun.clone()),
        ("unitRule", unit_rule(words, &slice.units)?),
    ]));
    Ok(format!(
        "{}{}",
        repo_directive(&ctx.repo),
        content::prompt("lens-confined", &v)?
    ))
}
