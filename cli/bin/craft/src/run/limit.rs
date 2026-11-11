//! An account's usage limit in what a host CLI said when it failed (lib/usage-limit.mjs; realm
//! @nick/craft, nodes #298, #299): every task after it fails the same way until the limit resets,
//! so the run stops. Only an account limit with a reset matches; a transient rate limit ("hit your
//! rate limit", 429) is an ordinary failure the binary hands out again.

use std::sync::LazyLock;

use regex::Regex;

/// `hit your <word> limit`, the word kept to rule out `rate`.
static HIT: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"(?i)\bhit your (?:([\w-]+) )?limit\b").ok());
static OTHERS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"(?i)\b(?:usage|weekly|daily|monthly|session|5-hour) limit\b[^\n]*\b(?:reached|resets?)\b",
        r"(?i)\breached (?:your|the) (?:\w+ )?usage limit\b",
    ]
    .iter()
    .filter_map(|p| Regex::new(p).ok())
    .collect()
});

fn says_limit(line: &str) -> bool {
    let hit = HIT.as_ref().is_some_and(|re| {
        re.captures_iter(line).any(|c| {
            c.get(1)
                .is_none_or(|w| !w.as_str().eq_ignore_ascii_case("rate"))
        })
    });
    hit || OTHERS.iter().any(|re| re.is_match(line))
}

/// The line of `text` that says the usage limit, whitespace folded and cut to 200 characters;
/// `None` when no line does.
pub(crate) fn usage_limit_text(text: &str) -> Option<String> {
    text.lines()
        .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
        .find(|l| says_limit(l))
        .map(|l| l.chars().take(200).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_account_limit_matches_and_a_rate_limit_does_not() {
        assert_eq!(
            usage_limit_text("boom\nERROR: You've hit your  usage limit. Try again in 3 hours."),
            Some("ERROR: You've hit your usage limit. Try again in 3 hours.".into())
        );
        assert!(usage_limit_text("You've hit your limit · resets 5pm").is_some());
        assert!(usage_limit_text("Weekly limit reached, resets Monday").is_some());
        assert!(usage_limit_text("you have reached your monthly usage limit").is_some());
        assert_eq!(usage_limit_text("You hit your rate limit, retry"), None);
        assert_eq!(usage_limit_text("429 Too Many Requests"), None);
        assert_eq!(usage_limit_text(""), None);
    }
}
