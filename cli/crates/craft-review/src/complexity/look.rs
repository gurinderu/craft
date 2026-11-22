//! When the complexity lens has been able to look: one decision over what the binary read of the
//! graph's numbers, which the plan, its notes, the coverage gaps and the lens's table all follow.

use crate::prompts::PromptContext;

/// What the metrics read came to, the index ready.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Look {
    /// Some function the change touches has its numbers: the lens runs. Files beside them not
    /// wholly read are named in its table; that is no coverage gap.
    Measured,
    /// The read went through and no function the change touches came back: the files hold none
    /// (types, re-exports, constants), or the graph holds no such name, which an empty answer
    /// cannot tell apart (realm @nick/craft, node #613). A note, no gap: the verdict may approve.
    NothingToJudge(String),
    /// The read failed, or nothing was measured and files went unread: there may be functions it
    /// never saw. A coverage gap, capping the verdict at Warning; why, with each file.
    CouldNotLook(String),
}

/// What the metrics read of `ctx` came to; `None` when the index was not ready to read from.
#[must_use]
pub fn look(ctx: &PromptContext) -> Option<Look> {
    let c = &ctx.consumers;
    // A read that failed was made of a ready index, though a move since may have unset it.
    let ready = !ctx.graph_project.is_empty() && (c.graph_indexed || !c.metrics_failed.is_empty());
    if !ready {
        return None;
    }
    Some(if !c.metrics_failed.is_empty() {
        Look::CouldNotLook(format!(
            "the graph's numbers could not be read ({})",
            one_line(&c.metrics_failed)
        ))
    } else if !c.metrics.is_empty() {
        Look::Measured
    } else if !c.metrics_unread.is_empty() {
        Look::CouldNotLook(format!(
            "no function the change touches was measured, and these files were not wholly read: {}",
            one_line(&c.metrics_unread.join(" · "))
        ))
    } else if c.metrics_empty.is_empty() {
        Look::NothingToJudge(
            "no function the change touches carries the code graph's numbers".into(),
        )
    } else {
        Look::NothingToJudge(format!(
            "the graph answered no function with numbers for {}",
            one_line(&c.metrics_empty.join(", "))
        ))
    })
}

/// `s` on one line, as the report and the verdict line show it: names keep their underscores.
fn one_line(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}

/// The coverage gap `look` files when the lens could not look, as "Not run" names it.
#[must_use]
pub fn gap(look: &Look) -> Option<String> {
    match look {
        Look::CouldNotLook(why) => Some(format!(
            "metrics-only lens complexity could not look — {why}"
        )),
        Look::Measured | Look::NothingToJudge(_) => None,
    }
}
