use super::super::{Error, pattern::Engine};
use super::{Raw, lines::Document, patterns::escape};

fn base(url: &str) -> &str {
    let start = url.find("://").map_or(0, |i| i + 3);
    let sub = url
        .get(start..)
        .and_then(|s| s.find("//"))
        .map(|i| start + i);
    sub.and_then(|i| url.get(..i)).unwrap_or(url)
}

pub(super) fn candidates(engine: &Engine, doc: &Document<'_>) -> Result<Vec<Raw>, Error> {
    let mut out = Vec::new();
    let raws: Vec<&str> = doc.lines.iter().map(|l| l.raw).collect();
    let found = engine.captures_all(
        r#"^[ \t]*source[ \t]*=[ \t]*"git::([^"?\s]+)\?((?:[^"\s]*&)?ref=)([^"&\s]+)[^"\s]*""#,
        &raws,
    )?;
    for m in found.into_iter().flatten() {
        let get = |i| m.get(i).map_or("", String::as_str);
        let (url, query, version) = (get(1), get(2), get(3));
        let base = base(url);
        let name = base
            .trim_end_matches('/')
            .rsplit(['/', ':'])
            .next()
            .unwrap_or("");
        out.push(Raw {
            system: name.strip_suffix(".git").unwrap_or(name).into(),
            repo: if base.starts_with("https://") {
                base.into()
            } else {
                String::new()
            },
            guessed: false,
            version: version.into(),
            note: String::new(),
            pattern: format!(
                r#"source[ \t]*=[ \t]*"git::{}\?{}([^"&\s]+)"#,
                escape(url),
                escape(query)
            ),
        });
    }
    Ok(out)
}
