//! The red team's prompt, as `redTeamPrompt` in `lib/review-adjudicate-priors.mjs` renders it:
//! the prior finding as the adjudicator saw it, and the invariant it named — its own rationale when
//! it named none (`redTeamInvariant`).

use serde_json::Value;

use super::{PromptContext, flatten, repo_directive, sanitize};
use crate::absorbed;
use crate::content::{self, ContentError, vars};
use crate::ledger::LedgerRow;

/// The prompt of the agent that attacks the fix of `row`, adjudicated resolved under `invariant`.
///
/// # Errors
/// When the template is missing or a placeholder has no value.
pub fn red_team_prompt(
    ctx: &PromptContext,
    row: &LedgerRow,
    invariant: &str,
) -> Result<String, ContentError> {
    let field = |s: &str| flatten(Some(&Value::String(s.to_owned())));
    let or = |s: String, empty: &str| if s.is_empty() { empty.to_owned() } else { s };
    let named = sanitize(invariant);
    let body = content::prompt(
        "red-team",
        &vars([
            ("severity", field(&row.severity)),
            ("title", field(&row.title)),
            ("file", field(&row.file)),
            ("line", row.line.to_string()),
            ("symbol", or(field(&row.symbol), "?")),
            ("ruleId", or(field(&row.rule_id), "—")),
            ("why", sanitize(&absorbed::without_absorbed(&row.why))),
            ("absorbed", absorbed::prompt_block(&row.why)),
            ("invariant", or(named, &sanitize(&row.why))),
        ]),
    )?;
    Ok(format!("{}{body}", repo_directive(&ctx.repo)))
}
