use super::super::{Error, pattern::Engine, text};

pub(in super::super) struct Key {
    pub col: usize,
    pub dash: bool,
    pub key: String,
    pub value: String,
    pub rest: String,
}

pub(in super::super) struct Line<'a> {
    pub raw: &'a str,
    pub key: Option<Key>,
    pub blank: bool,
    pub lead: usize,
}

pub(in super::super) struct Document<'a> {
    pub lines: Vec<Line<'a>>,
}

fn scalar(engine: &Engine, raw: &str) -> Result<String, Error> {
    let comment = raw.char_indices().find(|(i, c)| {
        *c == '#' && (*i == 0 || raw.get(..*i).is_some_and(|s| s.ends_with([' ', '\t'])))
    });
    let v = raw
        .get(..comment.map_or(raw.len(), |(i, _)| i))
        .unwrap_or("")
        .trim_matches(text::whitespace);
    let unquoted = engine.captures(r#"^(["'])(.*)\1$"#, v)?;
    let s = unquoted
        .as_ref()
        .and_then(|m| m.get(2))
        .map_or(v, String::as_str);
    if s.is_empty() || engine.matches(r#"^[{}[\]|>&*!`$\s"']|\{\{|\$\{|\s"#, s)? {
        return Ok(String::new());
    }
    Ok(s.to_owned())
}

fn key_line(engine: &Engine, line: &str) -> Result<Option<Key>, Error> {
    let Some(m) = engine.captures(
        r"^([ \t]*)(-[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*):(?:[ \t]+(.*?))?[ \t\r]*$",
        line,
    )?
    else {
        return Ok(None);
    };
    let get = |i| m.get(i).map_or("", String::as_str);
    let col = get(1).len() + get(2).len();
    Ok(Some(Key {
        col,
        dash: !get(2).is_empty(),
        key: get(3).into(),
        value: scalar(engine, get(4))?,
        rest: line
            .get(col..)
            .unwrap_or("")
            .trim_end_matches([' ', '\t', '\r'])
            .into(),
    }))
}

impl<'a> Document<'a> {
    pub(in super::super) fn new(engine: &Engine, text: &'a str) -> Result<Self, Error> {
        let lines = text
            .split('\n')
            .map(|raw| {
                Ok(Line {
                    raw,
                    key: key_line(engine, raw)?,
                    blank: engine.matches(r"^[ \t]*(?:#.*)?\r?$", raw)?,
                    lead: raw.len() - raw.trim_start_matches([' ', '\t']).len(),
                })
            })
            .collect::<Result<_, Error>>()?;
        Ok(Self { lines })
    }

    pub(super) fn key(&self, i: usize) -> Option<&Key> {
        self.lines.get(i)?.key.as_ref()
    }

    fn below(&self, i: usize, at: &Key, key: &str) -> Option<usize> {
        for (j, line) in self
            .lines
            .iter()
            .enumerate()
            .skip(i + 1)
            .filter(|(_, l)| !l.blank)
        {
            if line.lead < at.col {
                return None;
            }
            if line
                .key
                .as_ref()
                .is_some_and(|k| k.col == at.col && k.key == key)
            {
                return Some(j);
            }
        }
        None
    }

    fn above(&self, i: usize, at: &Key, key: &str) -> Option<usize> {
        for (j, line) in self
            .lines
            .iter()
            .enumerate()
            .take(i)
            .rev()
            .filter(|(_, l)| !l.blank)
        {
            if line
                .key
                .as_ref()
                .is_some_and(|k| k.col == at.col && k.key == key)
            {
                return Some(j);
            }
            if line.lead < at.col || line.key.as_ref().is_some_and(|k| k.dash && k.col == at.col) {
                return None;
            }
        }
        None
    }

    pub(super) fn sibling(&self, i: usize, key: &str, tag: bool) -> Option<(usize, &str)> {
        let at = self.key(i)?;
        let j = self
            .below(i, at, key)
            .or_else(|| (!at.dash).then(|| self.above(i, at, key)).flatten())?;
        let value = self.key(j)?.value.as_str();
        (!(value.is_empty() || tag && value == "latest")).then_some((j, value))
    }
}
