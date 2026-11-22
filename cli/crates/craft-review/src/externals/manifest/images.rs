use super::super::{Error, pattern::Engine};
use super::{Raw, lines::Document, patterns};

fn split<'a>(engine: &Engine, value: &'a str) -> Result<Option<(&'a str, &'a str)>, Error> {
    let digest = engine.captures(r"(@[sS][hH][aA]256:[0-9a-fA-F]+)$", value)?;
    let end = value.len()
        - digest
            .as_ref()
            .and_then(|m| m.first())
            .map_or(0, String::len);
    let plain = value.get(..end).unwrap_or("");
    let Some(colon) = plain
        .rfind(':')
        .filter(|i| plain.rfind('/').is_none_or(|slash| *i > slash))
    else {
        return Ok(None);
    };
    let (name, tag) = (
        plain.get(..colon).unwrap_or(""),
        plain.get(colon + 1..).unwrap_or(""),
    );
    Ok((!name.is_empty() && !tag.is_empty() && tag != "latest").then_some((name, tag)))
}

fn image(engine: &Engine, name: &str, tag: &str, pattern: String) -> Result<Raw, Error> {
    let repo = engine
        .captures(r"^ghcr\.io/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)", name)?
        .map(|m| {
            format!(
                "https://github.com/{}/{}",
                m.get(1).map_or("", String::as_str),
                m.get(2).map_or("", String::as_str)
            )
        })
        .unwrap_or_default();
    let note = if repo.is_empty() {
        String::new()
    } else {
        format!("repo guessed from the image {name}")
    };
    Ok(Raw {
        system: name.rsplit('/').next().unwrap_or("").into(),
        guessed: !repo.is_empty(),
        repo,
        version: tag.into(),
        pattern,
        note,
    })
}

pub(super) fn inline(engine: &Engine, doc: &Document<'_>) -> Result<Vec<Raw>, Error> {
    let mut out = Vec::new();
    for k in doc
        .lines
        .iter()
        .filter_map(|l| l.key.as_ref())
        .filter(|k| k.key == "image" && !k.value.is_empty())
    {
        if let Some((name, tag)) = split(engine, &k.value)? {
            let at = k.rest.find(name).map_or(name.len(), |i| i + name.len() + 1);
            out.push(image(
                engine,
                name,
                tag,
                patterns::inline(k.rest.get(..at).unwrap_or(&k.rest)),
            )?);
        }
    }
    Ok(out)
}

pub(super) fn pairs(
    engine: &Engine,
    doc: &Document<'_>,
    kustomize: bool,
) -> Result<Vec<Raw>, Error> {
    let mut out = Vec::new();
    for (i, line) in doc.lines.iter().enumerate() {
        let Some(k) = line.key.as_ref().filter(|k| !k.value.is_empty()) else {
            continue;
        };
        let eligible = if kustomize {
            k.dash && k.key == "name"
        } else {
            k.key == "repository" && !k.value.contains(':')
        };
        if !eligible {
            continue;
        }
        let key = if kustomize { "newTag" } else { "tag" };
        let Some((j, tag)) = doc.sibling(i, key, true) else {
            continue;
        };
        let name = if kustomize {
            doc.sibling(i, "newName", false)
                .map_or(k.value.clone(), |(_, s)| s.into())
        } else {
            doc.sibling(i, "registry", false)
                .map_or(k.value.clone(), |(_, s)| format!("{s}/{}", k.value))
        };
        out.push(image(engine, &name, tag, patterns::pair(doc, i, j, key))?);
    }
    Ok(out)
}
