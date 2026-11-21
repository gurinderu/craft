//! What a request hears when its text is already in the session's context (realm @nick/craft,
//! node #288): nothing for a per-kind text; for the conditional text of a prompt in another
//! script, one reminder line beside a sign of PR or review work, or once the text and its last
//! reminder are more than 30 minutes old, else a logged silence.

use serde_json::Value;

use super::entry::{Entry, field};
use super::heard::{prompt_spoke, said_in_session, since_reset, spoke};
use super::iso;
use super::kind::{Kind, work_sign};

/// The `reason` of the one line a later prompt in another script hears.
pub const REMINDER: &str = "language-reminder";
/// The silence, and `reason`, of a later prompt in another script that hears nothing: the reason
/// keeps it from counting as the request a bare continuation takes its kind from.
const NO_SIGN: &str = "no-work-sign";
/// How long the conditional text or a reminder stays fresh in the session's mind.
const FRESH_MS: i64 = 30 * 60 * 1000;

/// The kinds whose text, once said, makes the text for `kind` unneeded: each covers its own;
/// Codex's one English text names both English kinds.
fn covered_by(codex: bool, kind: Kind) -> Vec<&'static str> {
    if codex && kind != Kind::OtherLanguage {
        vec!["findings", "review"]
    } else {
        vec![kind.name()]
    }
}

/// Whether the conditional text and every reminder after it were said more than 30 minutes before
/// `now` (or at a time the log does not give).
fn stale(log: &[Value], session: &str, now: i64) -> bool {
    since_reset(log, session)
        .into_iter()
        .filter(|e| {
            prompt_spoke(e, Some(&[Kind::OtherLanguage.name()]))
                || spoke(e) && field(e, "reason") == Some(REMINDER)
        })
        .filter_map(|e| field(e, "ts").and_then(iso::parse))
        .max()
        .is_none_or(|t| now - t > FRESH_MS)
}

/// What `prompt`, of `kind`, hears at `now` when its text was already said: nothing for a per-kind
/// text (`already-said`); for the conditional one the reminder beside a sign of PR or review work
/// or once the text is stale, else nothing (`no-work-sign`: a bare go-ahead in another script asks
/// for no review work); `None` when that text is not there.
pub fn repeat_of(
    log: &[Value],
    session: &str,
    codex: bool,
    kind: Kind,
    prompt: &str,
    now: i64,
) -> Option<&'static str> {
    if !said_in_session(log, session, Some(&covered_by(codex, kind))) {
        return None;
    }
    Some(match kind {
        Kind::OtherLanguage if work_sign(prompt) || stale(log, session, now) => REMINDER,
        Kind::OtherLanguage => NO_SIGN,
        Kind::Findings | Kind::Review => "already-said",
    })
}

/// The line of a request that hears nothing for `why`.
pub fn hushed(entry: Entry, why: &str) -> Entry {
    let entry = entry.quiet(why);
    if why == NO_SIGN {
        entry.because(why)
    } else {
        entry
    }
}
