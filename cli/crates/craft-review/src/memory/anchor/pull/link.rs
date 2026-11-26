//! The GitHub pull request URLs among a record's links (`pullLinks` in
//! `integrations/shared/prior-decision-record.mjs`, realm @nick/craft, node #682).

use serde_json::Value;

use super::super::super::record::text;
use super::Pull;

/// The pull requests `links` name, in their order: each `https://github.com/<owner>/<name>/pull/<N>`,
/// whatever follows it after `/`, `#` or `?`, the host and the path case-insensitive.
pub(in crate::memory) fn pulls(links: &[Value]) -> Vec<Pull> {
    links.iter().filter_map(|l| pull(&text(Some(l)))).collect()
}

fn pull(link: &str) -> Option<Pull> {
    let head = "https://github.com/";
    let rest = link
        .get(..head.len())
        .filter(|h| h.eq_ignore_ascii_case(head))
        .and_then(|_| link.get(head.len()..))?;
    let mut parts = rest.splitn(4, '/');
    let (owner, name) = (parts.next()?, parts.next()?);
    let named = |s: &str| {
        !s.is_empty()
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    };
    let pull = parts.next().filter(|p| p.eq_ignore_ascii_case("pull"));
    if !(named(owner) && named(name)) || pull.is_none() {
        return None;
    }
    let tail = parts.next()?;
    let digits = tail.bytes().take_while(u8::is_ascii_digit).count();
    let rest = tail.get(digits..)?;
    let fits = (1..=9).contains(&digits) && !tail.starts_with('0');
    let ends = rest.is_empty() || rest.starts_with(['/', '#', '?']);
    if !(fits && ends) {
        return None;
    }
    Some(Pull {
        repo: format!("{owner}/{name}").to_ascii_lowercase(),
        number: tail.get(..digits)?.parse().ok()?,
    })
}
