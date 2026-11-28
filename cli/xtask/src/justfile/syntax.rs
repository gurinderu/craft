//! The pieces of just's syntax the reader needs: a recipe header, an attribute line's inside, a setting.

/// The names in `group('…')` / `group("…")` of an attribute line's inside.
pub(super) fn groups_in(inner: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = inner;
    while let Some(at) = rest.find("group(") {
        let (_, after) = rest.split_at(at + "group(".len());
        let quoted = after.trim_start();
        let Some(quote) = quoted.chars().next().filter(|c| *c == '\'' || *c == '"') else {
            break;
        };
        let (_, value) = quoted.split_at(quote.len_utf8());
        let Some(end) = value.find(quote) else { break };
        let (name, tail) = value.split_at(end);
        out.push(name.to_owned());
        rest = tail;
    }
    out
}

/// `name params…:` — a recipe header; `None` for a setting, an assignment or anything else.
pub(super) fn header(line: &str) -> Option<(String, Vec<String>)> {
    const KEYWORDS: [&str; 5] = ["set ", "export ", "alias ", "import ", "mod "];
    if KEYWORDS.iter().any(|k| line.starts_with(k)) {
        return None;
    }
    let colon = line.find(':')?;
    let (head, tail) = line.split_at(colon);
    if tail.starts_with(":=") {
        return None;
    }
    let mut words = head.trim_start_matches('@').split_whitespace();
    let name = words.next()?;
    let valid = name
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !valid {
        return None;
    }
    let params = words
        .map(|w| w.trim_start_matches(['*', '+']).trim_start_matches('$'))
        .map(|w| w.split('=').next().unwrap_or(w).to_owned())
        .collect();
    Some((name.to_owned(), params))
}

/// Whether an attribute line's inside names `script` (`[script]`, `[script('bash')]`): the body runs as one script.
pub(super) fn names_script(inner: &str) -> bool {
    inner.split(',').any(|a| {
        let a = a.trim();
        a == "script" || a.starts_with("script(")
    })
}

/// Whether the justfile sets `ignore-errors` (to anything but `false`): every recipe line then ignores its failure.
pub fn ignores_errors(text: &str) -> bool {
    text.lines().any(|line| {
        let compact: String = line.chars().filter(|c| !c.is_whitespace()).collect();
        compact.starts_with("setignore-errors") && compact != "setignore-errors:=false"
    })
}
