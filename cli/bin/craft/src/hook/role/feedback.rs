//! The findings class read from a request's grammar (realm @nick/craft, nodes #288, #287): feedback
//! as the thing worked on ("address the feedback", not "the feedback form"), and a comment or fix
//! word put apart from the PR or review it is about ("check the PR for new comments"), unless that
//! PR or review is the one the request makes ("fix the bug and open a PR").

use super::js::{self, Re, compile};

// Feedback worked on, its follower read apart: JS reads this pattern with a lookahead.
static FIX_FEEDBACK: Re = Re::new(|| {
    compile(
        r"(?i){B}(?:fix|address|resolve|apply|handle)(?:es|ed|ing)?[{S}]+(?:the[{S}]+|all[{S}]+|this[{S}]+|that[{S}]+|their[{S}]+|your[{S}]+|our[{S}]+)?feedback",
    )
});
static FOLLOWER: Re = Re::new(|| compile(r"(?i)^[{S}]+(?:on|from|in|and|then|by|left|please){B}"));
static LETTER_FIRST: Re = Re::new(|| compile(r"^\p{L}"));
static PULL_REQUEST: Re = Re::new(|| compile(r"(?i)(pull|merge)[- ]request"));
static WORD: Re = Re::new(|| compile(r"[\p{L}\p{N}']+"));

/// Whether "feedback" ending at `rest`'s start is the thing worked on: what follows is the end,
/// no letter, or a preposition or conjunction.
fn follows(rest: &str) -> bool {
    !LETTER_FIRST.is_match(rest.trim_start_matches(js::is_space)) || FOLLOWER.is_match(rest)
}

/// Whether the text works on feedback ("address the feedback.").
pub fn feedback_worked(text: &str) -> bool {
    let Some(re) = FIX_FEEDBACK.get() else {
        return false;
    };
    let mut from = 0;
    while let Some(m) = re.find_at(text, from) {
        if text.get(m.end()..).is_some_and(follows) {
            return true;
        }
        from = m.start()
            + text
                .get(m.start()..)
                .and_then(|s| s.chars().next())
                .map_or(1, char::len_utf8);
    }
    false
}

const NEAR: usize = 5;
const MAKE: [&str; 10] = [
    "open", "create", "push", "raise", "submit", "make", "file", "send", "request", "put",
];
const FILLER: [&str; 8] = ["a", "an", "the", "new", "draft", "up", "for", "another"];
const DETERMINER: [&str; 17] = [
    "the", "a", "an", "this", "that", "these", "those", "my", "our", "your", "their", "its", "any",
    "all", "other", "on", "in",
];

fn one_of(word: &str, list: &[&str]) -> bool {
    list.iter().any(|w| word.eq_ignore_ascii_case(w))
}

fn target(w: &str) -> bool {
    matches!(w, "PR" | "MR" | "PRs" | "MRs")
        || one_of(
            w,
            &[
                "review",
                "reviews",
                "reviewing",
                "pullrequest",
                "pullrequests",
                "mergerequest",
                "mergerequests",
            ],
        )
}

fn comment(w: &str) -> bool {
    one_of(w, &["comment", "comments"])
}

fn fix(w: &str) -> bool {
    ["fix", "address", "resolve"].iter().any(|stem| {
        w.get(..stem.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(stem))
            && w.get(stem.len()..)
                .is_some_and(|tail| one_of(tail, &["", "es", "ed", "ing"]))
    })
}

/// The positions of the PRs and reviews in a clause's words that it does not make.
fn targets_in(words: &[&str]) -> Vec<usize> {
    let word = |j: usize| words.get(j).copied().unwrap_or("");
    let made = |i: usize| {
        let mut j = i;
        while j > 0 && one_of(word(j - 1), &FILLER) {
            j -= 1;
        }
        j > 0 && one_of(word(j - 1), &MAKE) && !(j > 1 && one_of(word(j - 2), &DETERMINER))
    };
    (0..words.len())
        .filter(|&i| target(word(i)) && !made(i))
        .collect()
}

/// The text's clauses: split at `,`, `;`, `!`, `?`, and a `.` before a space or the end.
fn clauses(text: &str) -> Vec<String> {
    let mut out = vec![String::new()];
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        let ends = matches!(c, ',' | ';' | '!' | '?')
            || c == '.' && chars.peek().is_none_or(|&n| js::is_space(n));
        if ends {
            out.push(String::new());
        } else if let Some(last) = out.last_mut() {
            last.push(c);
        }
    }
    out
}

/// A comment or fix word about a PR or review the request does not make.
pub fn work_on_feedback(text: &str) -> bool {
    let joined = PULL_REQUEST.get().map_or_else(
        || text.to_owned(),
        |r| r.replace_all(text, "${1}request").into_owned(),
    );
    let clauses = clauses(&joined);
    let words: Vec<Vec<&str>> = clauses
        .iter()
        .map(|c| {
            WORD.get()
                .map(|r| r.find_iter(c).map(|m| m.as_str()).collect())
                .unwrap_or_default()
        })
        .collect();
    let targets: Vec<Vec<usize>> = words.iter().map(|w| targets_in(w)).collect();
    if targets.iter().all(Vec::is_empty) {
        return false;
    }
    words.iter().zip(&targets).any(|(words, near)| {
        words
            .iter()
            .enumerate()
            .any(|(i, w)| comment(w) || fix(w) && near.iter().any(|&t| t.abs_diff(i) <= NEAR))
    })
}
