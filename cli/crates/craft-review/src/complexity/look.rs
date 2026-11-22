//! When the complexity lens has been able to look: one decision over what the binary read of the
//! graph's numbers, which the plan, its notes, the coverage gaps and the lens's table all follow.

use crate::prompts::PromptContext;

/// What the metrics read came to, the index ready.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Look {
    /// Some function the change touches has its numbers: the lens runs. Files beside them not
    /// wholly read are named in its table; that is no coverage gap.
    Measured,
    /// The read went through and no function the change touches came back, and the graph's probe
    /// found numbers elsewhere, so its properties are as asked: the files hold none (types,
    /// re-exports, constants; realm @nick/craft, node #613). A note, no gap: the verdict may
    /// approve.
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
            bounded(&c.metrics_failed)
        ))
    } else if !c.metrics.is_empty() {
        Look::Measured
    } else if !c.metrics_unread.is_empty() {
        Look::CouldNotLook(format!(
            "no function the change touches was measured, and these files were not wholly read: {}",
            listed(&c.metrics_unread, " · ")
        ))
    } else if c.metrics_empty.is_empty() {
        Look::NothingToJudge(
            "no function the change touches carries the code graph's numbers".into(),
        )
    } else {
        Look::NothingToJudge(format!(
            "the graph answered no function with numbers for {}",
            listed(&c.metrics_empty, ", ")
        ))
    })
}

/// How many files a gap or a note names before it counts the rest.
const FILES_SHOWN: usize = 5;

/// How many characters a gap's or a note's own text runs to, so the verdict line stays readable.
const TEXT_MAX: usize = 600;

/// `s` on one line and at most [`TEXT_MAX`] characters, as the report and the verdict line show
/// it: names keep their underscores.
fn bounded(s: &str) -> String {
    let flat: String = s
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    if flat.chars().count() <= TEXT_MAX {
        return flat;
    }
    let cut: String = flat.chars().take(TEXT_MAX).collect();
    format!("{cut}…")
}

/// `items` joined by `sep`, at most [`FILES_SHOWN`] of them, [`bounded`], then how many more —
/// outside the cut, so the count survives it.
fn listed(items: &[String], sep: &str) -> String {
    let shown = items.iter().take(FILES_SHOWN).map(String::as_str);
    let mut text = bounded(&shown.collect::<Vec<_>>().join(sep));
    if items.len() > FILES_SHOWN {
        text.push_str(&format!(" +{} more", items.len() - FILES_SHOWN));
    }
    text
}

/// The coverage gap `look` files when the lens could not look, as "Not run" names it.
#[must_use]
pub fn gap(look: &Look) -> Option<String> {
    match look {
        Look::CouldNotLook(why) => Some(craft_store::gap::entry(
            "metrics-only lens complexity could not look",
            why,
        )),
        Look::Measured | Look::NothingToJudge(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{TEXT_MAX, bounded, listed};

    #[test]
    fn a_gap_names_a_few_files_and_counts_the_rest_on_one_bounded_line() {
        let files: Vec<String> = (0..8).map(|i| format!("src/m_{i}.rs (cut)")).collect();
        let text = listed(&files, " · ");
        assert!(
            text.contains("src/m_4.rs") && !text.contains("src/m_5.rs"),
            "{text}"
        );
        assert!(text.ends_with(" +3 more"), "{text}");
        let wide: Vec<String> = (0..8).map(|i| format!("{i}{}", "y".repeat(400))).collect();
        assert!(
            listed(&wide, " · ").ends_with("… +3 more"),
            "the count survives the cut"
        );
        let long = bounded(&format!("a\nb{}", "x".repeat(2000)));
        assert!(
            !long.contains('\n') && long.chars().count() == TEXT_MAX + 1,
            "{long}"
        );
    }
}
