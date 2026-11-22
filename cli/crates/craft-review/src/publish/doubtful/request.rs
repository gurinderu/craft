//! The doubtful finding chosen for one review comment of a run record's `sorting.findings`, as
//! `findingPostRequest` in the JavaScript `finding-post` built it (frozen in
//! `content/parity/finding-post-cases.json`): the comment body with the craft-finding marker last,
//! a question's ask and kind line, anchored to its line (`line`, `side: RIGHT`, no `subject_type`,
//! which GitHub refuses beside `line` with 422; realm @nick/craft, node #381), or to its file when
//! its line is outside the diff or not judged.

use serde_json::Value;

use super::super::body;
use crate::js;

/// A finding chosen to post: its anchor and its comment body.
pub(super) struct Chosen<'a> {
    pub(super) finding: &'a Value,
    pub(super) file: String,
    pub(super) line: Option<u32>,
    pub(super) body: String,
}

/// Doubtful finding `n` of `findings`, posted as a question when `question`; `lines_judged` false
/// (the record's `inDiffJudged`): no line is known to be in the diff, so it goes to its file.
///
/// # Errors
/// Why it cannot be posted: no finding numbered `n`, or one naming no file.
pub(super) fn chosen(
    findings: &[Value],
    n: f64,
    question: bool,
    lines_judged: bool,
) -> Result<Chosen<'_>, String> {
    let Some(finding) = findings
        .iter()
        .find(|x| js::number(x.get("n"), f64::NAN) - n == 0.0)
    else {
        return Err(format!(
            "the run record lists no doubtful finding numbered {}",
            js::number_text(n)
        ));
    };
    let file = match finding.get("file") {
        Some(Value::String(f)) if !js::trim(f).is_empty() => js::trim(f).to_owned(),
        _ => {
            return Err(format!(
                "finding {} names no file to anchor a review comment to",
                js::number_text(n)
            ));
        }
    };
    let line = js::number(finding.get("line"), f64::NAN);
    let outside = finding.get("outsideDiff") == Some(&Value::Bool(true));
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a positive whole number up to u32::MAX, checked first"
    )]
    let line = (lines_judged
        && !outside
        && line.fract() == 0.0
        && line > 0.0
        && line <= f64::from(u32::MAX))
    .then_some(line as u32);
    Ok(Chosen {
        finding,
        file,
        line,
        body: body::comment(finding, question),
    })
}

/// Whether `commit` reads as a commit sha.
pub(super) fn is_sha(commit: &str) -> bool {
    (7..=64).contains(&commit.len()) && commit.bytes().all(|b| b.is_ascii_hexdigit())
}
