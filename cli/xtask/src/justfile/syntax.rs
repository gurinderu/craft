//! The pieces of just's syntax the reader needs: a recipe header, an attribute line's inside, a directive.

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

/// A recipe header, as `header` reads it.
pub(super) struct Header {
    pub name: String,
    /// The parameters' names.
    pub params: Vec<String>,
    /// The parameters as written (`*args`, `base=""`).
    pub param_words: Vec<String>,
    pub dependencies: String,
}

/// `name params…:` — a recipe header; `None` for a setting, an assignment or anything else.
pub(super) fn header(line: &str) -> Option<Header> {
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
    let param_words: Vec<String> = words.map(str::to_owned).collect();
    let params = param_words
        .iter()
        .map(|w| w.trim_start_matches(['*', '+']).trim_start_matches('$'))
        .map(|w| w.split('=').next().unwrap_or(w).to_owned())
        .collect();
    let dependencies = tail.strip_prefix(':').unwrap_or(tail).trim().to_owned();
    Some(Header {
        name: name.to_owned(),
        params,
        param_words,
        dependencies,
    })
}

/// Each attribute of an attribute line's inside, split at its top-level commas, its whitespace dropped.
pub(super) fn attributes_in(inner: &str) -> Vec<String> {
    let mut out = vec![String::new()];
    let (mut depth, mut quote) = (0_u32, None::<char>);
    for c in inner.chars() {
        match (quote, c) {
            (Some(q), _) if c == q => quote = None,
            (None, '\'' | '"') => quote = Some(c),
            (None, '(') => depth += 1,
            (None, ')') => depth = depth.saturating_sub(1),
            (None, ',') if depth == 0 => {
                out.push(String::new());
                continue;
            }
            _ => {}
        }
        if let (false, Some(last)) = (quote.is_none() && c.is_whitespace(), out.last_mut()) {
            last.push(c);
        }
    }
    out.retain(|a| !a.is_empty());
    out
}

/// Every top-level line that is neither blank, a comment, an attribute, a recipe header nor a recipe's body —
/// settings, exports, assignments, aliases, imports, modules —, its whitespace collapsed to single spaces.
pub fn directives(text: &str) -> Vec<String> {
    text.lines()
        .filter(|l| !l.starts_with([' ', '\t']))
        .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|l| !l.is_empty() && !l.starts_with(['#', '[']) && header(l).is_none())
        .collect()
}
