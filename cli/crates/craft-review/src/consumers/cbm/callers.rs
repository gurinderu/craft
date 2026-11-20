//! The callers of a review's symbols, asked one query at a time within the budget.

use std::time::Instant;

use super::query::{self, Callers};
use super::{Asked, Caller, Cbm, CbmError, ROWS_PER_SYMBOL, is_ident};

/// Why a symbol's test callers were not asked when its non-test ones fill its rows.
const ROOM_SPENT: &str = "test callers not asked: the row budget is spent";

/// What asking one symbol came to.
#[derive(Debug, Default)]
struct One {
    rows: Vec<Caller>,
    cut: bool,
    /// How many rows the graph returned that do not read as a caller.
    unreadable: usize,
    /// Why its test callers were not asked, when they were not.
    tests_unasked: Option<String>,
    /// The failed test question, after which no further symbol is asked.
    failed: Option<CbmError>,
}

impl Asked {
    /// Takes in what asking `name` came to.
    fn record(&mut self, name: &str, one: One) {
        self.callers.extend(one.rows);
        if one.cut {
            self.truncated.push(name.to_owned());
        }
        if one.unreadable > 0 {
            self.unasked.push(format!(
                "{name} ({} of its caller rows unreadable)",
                one.unreadable
            ));
        }
        if let Some(why) = one.tests_unasked {
            self.unasked.push(format!("{name} ({why})"));
        }
    }
}

impl Cbm {
    /// The functions that call each of `symbols` (a name, an identifier, and the file it is
    /// defined in), by a `CALLS` edge: per symbol its non-test callers, then its test callers in
    /// the room left of [`ROWS_PER_SYMBOL`]. Past the budget, or when a later question fails, the
    /// answers so far are kept and the symbols left are named as not asked; a symbol whose test
    /// callers were not asked, or some of whose rows did not read, is named with why.
    ///
    /// # Errors
    /// When the graph does not answer the first question.
    pub fn callers(&self, project: &str, symbols: &[(&str, &str)]) -> Result<Asked, CbmError> {
        let mut out = Asked::default();
        let deadline = Instant::now() + self.budget;
        let mut todo = Vec::new();
        for &(name, file) in symbols.iter().filter(|s| is_ident(s.0)) {
            match query::quoted(file) {
                Some(q) => todo.push((name, q)),
                None => out
                    .unasked
                    .push(format!("{name} (its path cannot be quoted)")),
            }
        }
        let left = |from: usize, why: &CbmError| -> Vec<String> {
            let rest = todo.iter().skip(from);
            rest.map(|(n, _)| format!("{n} ({why})")).collect()
        };
        for (i, (name, file)) in todo.iter().enumerate() {
            let mut one = match self.callers_of(project, name, file, deadline) {
                Ok(one) => one,
                Err(why) if i == 0 => return Err(why),
                Err(why) => {
                    out.unasked.extend(left(i, &why));
                    break;
                }
            };
            let failed = one.failed.take();
            out.record(name, one);
            if let Some(why) = failed {
                out.unasked.extend(left(i + 1, &why));
                break;
            }
        }
        Ok(out)
    }

    /// The callers of `name` defined in `file` (quoted): non-test ones first, test ones in the
    /// room left. Refused only when the non-test question fails: a failed test question keeps
    /// the non-test callers and says why the test ones were not asked.
    fn callers_of(
        &self,
        project: &str,
        name: &str,
        file: &str,
        deadline: Instant,
    ) -> Result<One, CbmError> {
        let first = self.rows(
            project,
            name,
            file,
            Callers::NonTest,
            ROWS_PER_SYMBOL,
            deadline,
        )?;
        let room = ROWS_PER_SYMBOL - first.rows.len();
        let mut one = One {
            rows: first.rows,
            cut: first.cut,
            unreadable: first.unreadable,
            ..One::default()
        };
        if one.cut {
            return Ok(one);
        }
        if room == 0 {
            one.tests_unasked = Some(ROOM_SPENT.into());
            return Ok(one);
        }
        match self.rows(project, name, file, Callers::Test, room, deadline) {
            Ok(tests) => {
                one.rows.extend(tests.rows);
                one.cut = tests.cut;
                one.unreadable += tests.unreadable;
            }
            Err(why) => {
                one.tests_unasked = Some(format!("test callers not asked: {why}"));
                one.failed = Some(why);
            }
        }
        Ok(one)
    }
}
