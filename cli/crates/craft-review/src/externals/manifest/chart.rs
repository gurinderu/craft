use super::super::{Error, pattern::Engine};
use super::{Raw, lines::Document, patterns};

fn top<'a>(doc: &'a Document<'_>, key: &str) -> &'a str {
    doc.lines
        .iter()
        .filter_map(|l| l.key.as_ref())
        .find(|k| k.col == 0 && k.key == key)
        .map_or("", |k| k.value.as_str())
}

fn section(doc: &Document<'_>, key: &str) -> std::ops::Range<usize> {
    let Some(at) = doc
        .lines
        .iter()
        .position(|l| l.key.as_ref().is_some_and(|k| k.col == 0 && k.key == key))
    else {
        return 0..0;
    };
    let end = doc
        .lines
        .iter()
        .enumerate()
        .skip(at + 1)
        .find(|(_, l)| {
            l.raw
                .chars()
                .next()
                .is_some_and(|c| !craft_store::js::is_space(c) && c != '-')
        })
        .map_or(doc.lines.len(), |(i, _)| i);
    at + 1..end
}

fn application(engine: &Engine, doc: &Document<'_>) -> Result<Option<Raw>, Error> {
    let (name, version) = (top(doc, "name"), top(doc, "appVersion"));
    if name.is_empty() || version.is_empty() {
        return Ok(None);
    }
    let (mut has_source, mut repo) = (false, String::new());
    for i in section(doc, "sources") {
        let line = doc.lines.get(i).map_or("", |l| l.raw);
        has_source |= engine.matches(r"^[ \t]*-[ \t]+\S", line)?;
        if repo.is_empty() {
            repo = engine
                .captures(
                    r#"^[ \t]*-[ \t]+["']?(https://[^"'\s#]+)["']?[ \t\r]*(?:#.*)?$"#,
                    line,
                )?
                .and_then(|m| m.get(1).cloned())
                .unwrap_or_default();
        }
    }
    Ok(has_source.then(|| Raw {
        system: name.into(),
        repo,
        guessed: false,
        version: version.into(),
        pattern: format!(r"^appVersion:[ \t]*{}", patterns::VERSION),
        note: String::new(),
    }))
}

pub(super) fn candidates(engine: &Engine, doc: &Document<'_>) -> Result<Vec<Raw>, Error> {
    let mut out: Vec<_> = application(engine, doc)?.into_iter().collect();
    for i in section(doc, "dependencies") {
        let Some(k) = doc
            .key(i)
            .filter(|k| k.dash && k.key == "name" && !k.value.is_empty())
        else {
            continue;
        };
        let Some((j, version)) = doc.sibling(i, "version", false) else {
            continue;
        };
        out.push(Raw {
            system: k.value.clone(),
            repo: String::new(),
            guessed: false,
            version: version.into(),
            pattern: patterns::pair(doc, i, j, "version"),
            note: "a chart dependency's version — the upstream tag may differ".into(),
        });
    }
    Ok(out)
}
