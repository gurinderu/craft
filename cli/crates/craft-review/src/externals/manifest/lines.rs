use super::super::{Error, pattern::Engine};
use super::scalar::scalars;

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

const KEY: &str = r"^([ \t]*)(-[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*):(?:[ \t]+(.*?))?[ \t\r]*$";
const BLANK: &str = r"^[ \t]*(?:#.*)?\r?$";
fn key_lines(engine: &Engine, lines: &[&str]) -> Result<Vec<Option<Key>>, Error> {
    let found = engine.captures_all(KEY, lines)?;
    let get = |m: &[String], i: usize| m.get(i).map_or("", String::as_str).to_owned();
    let raws: Vec<String> = found.iter().flatten().map(|m| get(m, 4)).collect();
    let refs: Vec<&str> = raws.iter().map(String::as_str).collect();
    let mut values = scalars(engine, &refs)?.into_iter();
    Ok(lines
        .iter()
        .zip(found)
        .map(|(line, m)| {
            let m = m?;
            let col = get(&m, 1).len() + get(&m, 2).len();
            Some(Key {
                col,
                dash: !get(&m, 2).is_empty(),
                key: get(&m, 3),
                value: values.next().unwrap_or_default(),
                rest: line
                    .get(col..)
                    .unwrap_or("")
                    .trim_end_matches([' ', '\t', '\r'])
                    .into(),
            })
        })
        .collect())
}

impl<'a> Document<'a> {
    pub(in super::super) fn new(engine: &Engine, text: &'a str) -> Result<Self, Error> {
        let raws: Vec<&str> = text.split('\n').collect();
        let keys = key_lines(engine, &raws)?;
        let blanks = engine.captures_all(BLANK, &raws)?;
        let lines = raws
            .into_iter()
            .zip(keys)
            .zip(blanks)
            .map(|((raw, key), blank)| Line {
                raw,
                key,
                blank: blank.is_some(),
                lead: raw.len() - raw.trim_start_matches([' ', '\t']).len(),
            })
            .collect();
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
