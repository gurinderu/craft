//! The callers of a review's symbols, asked one query at a time within the budget.

use std::time::Instant;

use serde_json::{Value, json};

use super::{Asked, Caller, Cbm, ROWS_PER_SYMBOL, is_ident, query};

impl Cbm {
    /// The functions that call each of `symbols` (a name, an identifier, and the file it is
    /// defined in), by a `CALLS` edge: per symbol its non-test callers, then its test callers in
    /// the room left of [`ROWS_PER_SYMBOL`]. Past the budget, or when a later question fails, the
    /// answers so far are kept and the symbols left are named as not asked.
    ///
    /// # Errors
    /// When the graph does not answer the first question.
    pub fn callers(&self, project: &str, symbols: &[(&str, &str)]) -> Result<Asked, String> {
        let mut out = Asked::default();
        let start = Instant::now();
        let mut todo = Vec::new();
        for &(name, file) in symbols.iter().filter(|s| is_ident(s.0)) {
            match query::quoted(file) {
                Some(q) => todo.push((name, q)),
                None => out
                    .unasked
                    .push(format!("{name} (its path cannot be quoted)")),
            }
        }
        for (i, (name, file)) in todo.iter().enumerate() {
            match self.callers_of(project, name, file, start) {
                Ok((rows, cut)) => {
                    out.callers.extend(rows);
                    if cut {
                        out.truncated.push((*name).to_owned());
                    }
                }
                Err(why) if i == 0 => return Err(why),
                Err(why) => {
                    let left = todo.iter().skip(i).map(|(n, _)| format!("{n} ({why})"));
                    out.unasked.extend(left);
                    break;
                }
            }
        }
        Ok(out)
    }

    /// The callers of `name` defined in `file` (quoted): non-test ones first, test ones in the
    /// room left; whether any were cut.
    fn callers_of(
        &self,
        project: &str,
        name: &str,
        file: &str,
        start: Instant,
    ) -> Result<(Vec<Caller>, bool), String> {
        let (mut rows, cut) = self.rows(project, name, file, false, ROWS_PER_SYMBOL, start)?;
        let room = ROWS_PER_SYMBOL - rows.len();
        if cut || room == 0 {
            return Ok((rows, true));
        }
        let (tests, cut) = self.rows(project, name, file, true, room, start)?;
        rows.extend(tests);
        Ok((rows, cut))
    }

    /// Up to `max` caller rows of one query, and whether more were there; refused past the
    /// budget, each question's time held to what is left of it.
    fn rows(
        &self,
        project: &str,
        name: &str,
        file: &str,
        tests: bool,
        max: usize,
        start: Instant,
    ) -> Result<(Vec<Caller>, bool), String> {
        const BOUND: &str = "time bound";
        let left = self.budget.saturating_sub(start.elapsed());
        if left.is_zero() {
            return Err(BOUND.into());
        }
        let query = query::callers(name, file, tests, max + 1);
        let args = json!({"project": project, "query": query, "max_rows": max});
        let answer = self
            .call("query_graph", args, left.min(self.timeout))
            .map_err(|why| {
                if start.elapsed() >= self.budget {
                    BOUND.into()
                } else {
                    why
                }
            })?;
        let rows = answer.get("rows").and_then(Value::as_array);
        let rows: Vec<Caller> = rows.into_iter().flatten().filter_map(caller).collect();
        let flag = |k: &str| answer.get(k).and_then(Value::as_bool) == Some(true);
        let cut = flag("has_more") || flag("truncated") || rows.len() > max;
        Ok((rows.into_iter().take(max).collect(), cut))
    }
}

/// One `query_graph` row as a [`Caller`]; the graph prints numbers as strings.
fn caller(row: &Value) -> Option<Caller> {
    let cell = |i: usize| row.get(i);
    let num = |i: usize| -> Option<u32> {
        let v = cell(i)?;
        v.as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .or_else(|| v.as_str()?.parse().ok())
    };
    Some(Caller {
        symbol: cell(0)?.as_str()?.to_owned(),
        defined_in: cell(1)?.as_str()?.to_owned(),
        file: cell(2)?.as_str()?.to_owned(),
        start: num(3)?,
        end: num(4)?,
    })
}
