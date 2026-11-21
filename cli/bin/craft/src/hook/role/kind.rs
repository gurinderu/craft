//! Which human prompts the work hook answers (realm @nick/craft, node #288): the findings class,
//! the review class, a prompt in another script for the model to class itself, or none. The words
//! matched are English or script-neutral (PR and MR, their URLs).

use super::feedback::{feedback_worked, work_on_feedback};
use super::js::{self, Re, compile};
use super::word::{continuation, not_human, other_language};

/// A prompt's class.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Findings,
    Review,
    OtherLanguage,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Findings => "findings",
            Self::Review => "review",
            Self::OtherLanguage => "other-language",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "findings" => Some(Self::Findings),
            "review" => Some(Self::Review),
            "other-language" => Some(Self::OtherLanguage),
            _ => None,
        }
    }
}

// Working findings or PR comments; a bare "fix" or "comments" counts only beside review words.
static FINDINGS: [Re; 4] = [
    Re::new(|| compile(r"(?i){B}findings?{B}")),
    Re::new(|| {
        compile(
            r"(?i){B}(?:review|PR|MR|pull[- ]request|merge[- ]request|reviewer'?s?)[{S}]+(?:comments?|feedback|threads?|notes?|remarks?){B}",
        )
    }),
    Re::new(|| {
        compile(
            r"(?i){B}comments?[{S}]+(?:on|in|from)[{S}]+(?:the[{S}]+|this[{S}]+|that[{S}]+|my[{S}]+|our[{S}]+|your[{S}]+)?(?:PR|MR|pull[- ]request|merge[- ]request|review(?:er)?){B}",
        )
    }),
    Re::new(|| {
        compile(
            r"(?i){B}(?:fix|address|resolve|apply)(?:es|ed|ing)?[{S}]+(?:the[{S}]+|all[{S}]+|these[{S}]+|those[{S}]+)?(?:review|PR|MR){B}",
        )
    }),
];
// Asking for a review or naming a PR or MR; "reviewed" and "preview" are other words, a lowercase
// "pr" stands in paths and commands.
static REVIEW: [Re; 3] = [
    Re::new(|| compile(r"(?i){B}review(?:s|ing)?{B}")),
    Re::new(|| compile(r"{B}(?:PR|MR)s?{B}")),
    Re::new(|| compile(r"(?i){B}(?:pull|merge)[- ]requests?{B}")),
];
// Read on the prompt as written, paths and all.
static LINKS: [Re; 2] = [
    Re::new(|| compile(r"(?i){B}github\.com/[^{S}/]+/[^{S}/]+/pull/[0-9]+")),
    Re::new(|| compile(r"(?i)/merge_requests/[0-9]+")),
];
// A PR or issue by its number, after `#` or the numero sign; an HTML entity ("&#123;") is none.
static NUMBER: Re = Re::new(|| compile(r"(?:^|[^&A-Za-z0-9_])#[0-9]+{B}|\x{2116}[{S}]?[0-9]+"));
// A PR in lower case: a sign only beside another script, where it is no path or command.
static LOWER_PR: Re = Re::new(|| compile(r"{B}prs?{B}"));
static FILE: Re = Re::new(|| compile(r"^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.[a-z][a-z0-9]{0,5}$"));
static EXT: Re = Re::new(|| compile(r"\.[a-z][a-z0-9]{0,5}$"));
static HOME_OR_DOT: Re = Re::new(|| compile(r"^(?:\.{1,2}|~)/"));

/// Whether a whitespace-free token is a path or a file name ("lib/pr/x.mjs", "./review",
/// "review.js"); two words joined by one slash ("PR/MR") stay words.
fn pathlike(token: &str) -> bool {
    let t = token
        .trim_end_matches(['.', ',', ';', ':', '!', '?', ')', ']', '}', '"', '\'', '`'])
        .trim_start_matches(['(', '{', '"', '\'', '`', '[']);
    match t.matches('/').count() {
        0 => FILE.is_match(t),
        slashes => slashes >= 2 || HOME_OR_DOT.is_match(t) || EXT.is_match(t),
    }
}

/// The prompt with each path or file name put out as one space.
fn without_paths(prompt: &str) -> String {
    let mut out = String::with_capacity(prompt.len());
    let mut token = String::new();
    let flush = |token: &mut String, out: &mut String| {
        out.push_str(if pathlike(token) { " " } else { token });
        token.clear();
    };
    for c in prompt.chars() {
        if js::is_space(c) {
            flush(&mut token, &mut out);
            out.push(c);
        } else {
            token.push(c);
        }
    }
    flush(&mut token, &mut out);
    out
}

/// The class of a human prompt; a bare English continuation takes `recent`, the kind of the
/// request it continues; an agent's words the harness delivers as a prompt are no class.
pub fn prompt_kind(prompt: &str, recent: Option<Kind>) -> Option<Kind> {
    if not_human(prompt) {
        return None;
    }
    if other_language(prompt) {
        return Some(Kind::OtherLanguage);
    }
    let text = without_paths(prompt);
    let folded = js::ascii_case(&text);
    if FINDINGS.iter().any(|re| re.is_match(&folded))
        || feedback_worked(&text)
        || work_on_feedback(&text)
    {
        return Some(Kind::Findings);
    }
    let prompt_folded = js::ascii_case(prompt);
    if REVIEW.iter().any(|re| re.is_match(&folded))
        || LINKS.iter().any(|re| re.is_match(&prompt_folded))
    {
        return Some(Kind::Review);
    }
    if continuation(prompt) { recent } else { None }
}

/// Whether a prompt holds a sign of PR or review work that reads the same in any script: Latin PR
/// (in either case), MR or review as a word outside paths, a `#<number>` or a number after the
/// numero sign, or a PR or MR link. After the conditional text a later
/// prompt in another script hears the reminder only beside one (realm @nick/craft, node #288).
pub fn work_sign(prompt: &str) -> bool {
    let words = without_paths(prompt);
    let folded = js::ascii_case(&words);
    let prompt_folded = js::ascii_case(prompt);
    REVIEW.iter().any(|re| re.is_match(&folded))
        || LOWER_PR.is_match(&folded)
        || NUMBER.is_match(prompt)
        || LINKS.iter().any(|re| re.is_match(&prompt_folded))
}

#[cfg(test)]
#[path = "kind_tests.rs"]
mod tests;
