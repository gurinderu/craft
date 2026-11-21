//! Whose word a prompt is, in which script, and whether it is a bare "continue" (realm
//! @nick/craft, node #288; the case it answers, #287): the prompt hook speaks only on a human's
//! word, lets the model class a prompt in another script, and a continuation without a subject of
//! its own carries the kind of the request it continues.

use super::js::{Re, compile};

// What Claude Code delivers as a user prompt that no human wrote: a subagent's hand-back, a
// message from another Claude session on the same machine (#289) and a background task's
// notification on a line of its own.
static PREAMBLE: Re = Re::new(|| compile(r"^[{S}]*Another Claude session sent a message:"));
static MESSAGE: Re = Re::new(|| compile(r"^[{S}]*<(?:agent|cross-session)-message{B}"));
static NOTIFICATION: Re = Re::new(|| compile(r"(?mR)^[{S}]*<task-notification>[{S}]*$"));
// A subagent's hand-back; a message from another session or a task notification never is one.
static HANDBACK: Re = Re::new(|| {
    compile(r"^[{S}]*(?:Another Claude session sent a message:[{S}]*)?<agent-message{B}")
});
static LETTER: Re = Re::new(|| compile(r"\p{L}"));
static NON_LATIN: Re = Re::new(|| compile(r"[\p{L}&&\P{Latin}]"));
static WORD: Re = Re::new(|| compile(r"[\p{L}']+"));

/// Whether the prompt is the harness delivering an agent's words.
pub fn not_human(prompt: &str) -> bool {
    [&PREAMBLE, &MESSAGE, &NOTIFICATION]
        .iter()
        .any(|re| re.is_match(prompt))
}

/// Whether the prompt is a subagent's report.
pub fn subagent_report(prompt: &str) -> bool {
    HANDBACK.is_match(prompt)
}

fn count(re: &Re, text: &str) -> u32 {
    re.get().map_or(0, |r| {
        u32::try_from(r.find_iter(text).count()).unwrap_or(u32::MAX)
    })
}

/// Whether the prompt is mostly in a script other than Latin: at least 3 such letters, and at
/// least 0.3 of all its letters.
pub fn other_language(prompt: &str) -> bool {
    let letters = count(&LETTER, prompt);
    let other = count(&NON_LATIN, prompt);
    other >= 3 && f64::from(other) >= 0.3 * f64::from(letters)
}

const VERB: [&str; 9] = [
    "continue",
    "continuing",
    "proceed",
    "resume",
    "finish",
    "keep",
    "carry",
    "go",
    "wrap",
];
const REST: [&str; 29] = [
    "it", "the", "this", "that", "work", "job", "up", "on", "going", "ahead", "where", "you", "we",
    "left", "off", "stopped", "please", "pls", "plz", "ok", "okay", "so", "then", "now", "and",
    "just", "thanks", "good", "great",
];

/// Whether the prompt is a bare continuation ("keep going", "finish it please"): at most 8 words,
/// a verb among them, every one a verb or one of the rest.
pub fn continuation(prompt: &str) -> bool {
    let lower = prompt.to_lowercase();
    let words: Vec<&str> = WORD
        .get()
        .map(|r| r.find_iter(&lower).map(|m| m.as_str()).collect())
        .unwrap_or_default();
    if words.is_empty() || words.len() > 8 {
        return false;
    }
    let verb = |w: &&str| VERB.contains(w);
    words.iter().any(verb) && words.iter().all(|w| verb(w) || REST.contains(w))
}
