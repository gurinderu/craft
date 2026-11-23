use super::super::{Error, pattern::Engine};

const QUOTED: &str = r#"^(["'])(.*)\1$"#;
const UNREAD: &str = r#"^[{}[\]|>&*!`$\s"']|\{\{|\$\{|\s"#;

fn uncommented(raw: &str) -> &str {
    let comment = raw.char_indices().find(|(i, c)| {
        *c == '#' && (*i == 0 || raw.get(..*i).is_some_and(|s| s.ends_with([' ', '\t'])))
    });
    raw.get(..comment.map_or(raw.len(), |(i, _)| i))
        .unwrap_or("")
        .trim_matches(craft_store::js::is_space)
}

/// Each raw value's plain scalar, or "" when it is not one; a batch is matched in two calls.
pub(super) fn scalars(engine: &Engine, raws: &[&str]) -> Result<Vec<String>, Error> {
    let values: Vec<&str> = raws.iter().map(|r| uncommented(r)).collect();
    let unquoted = engine.captures_all(QUOTED, &values)?;
    let plain: Vec<String> = values
        .iter()
        .zip(unquoted)
        .map(|(v, m)| {
            m.and_then(|m| m.get(2).cloned())
                .unwrap_or_else(|| (*v).into())
        })
        .collect();
    let refs: Vec<&str> = plain.iter().map(String::as_str).collect();
    let unread = engine.captures_all(UNREAD, &refs)?;
    Ok(plain
        .into_iter()
        .zip(unread)
        .map(|(s, m)| if m.is_some() { String::new() } else { s })
        .collect())
}
