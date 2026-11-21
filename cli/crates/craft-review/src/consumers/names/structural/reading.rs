//! One candidate file of the structural search read: its lines that reach the item.

use std::path::Path;

use super::super::super::source;
use super::super::paths::{self, Resolver};
use super::super::unit::Workspace;
use super::{Found, Hit, Until, parse_until};

/// How many leading directories the paths `a` and `b` share.
pub(super) fn shared(a: &str, b: &str) -> usize {
    a.split('/')
        .zip(b.split('/'))
        .take_while(|(x, y)| x == y)
        .count()
}

/// What one candidate file is read for: the item and its owner, in the workspace at `top`.
pub(super) struct Reading<'a> {
    pub top: &'a Path,
    pub ws: &'a Workspace,
    pub own: (&'a str, &'a paths::Owner),
    pub rx: paths::Reexports<'a>,
    pub until: Until<'a>,
}

impl Reading<'_> {
    /// Adds the lines of the file `f` that reach the item to `found`, or the file to its
    /// unread ones.
    pub(super) fn read(&self, f: &str, found: &mut Found) -> Result<(), String> {
        let text = match source::read_within(self.top, f) {
            Ok(Some(t)) => t,
            Ok(None) => return Ok(()),
            Err(e) => {
                found.unread.push(format!("{f} ({e})"));
                return Ok(());
            }
        };
        let tree = parse_until(&text, self.until)?;
        let unit = self.ws.unit(f);
        let res = Resolver::new(&unit, &tree, &text);
        let lines: Vec<&str> = text.lines().collect();
        let rows = paths::reaching(&tree, &text, self.own, (&res, self.rx));
        found.hits.extend(rows.into_iter().map(|n| {
            let at = usize::try_from(n).ok().and_then(|n| n.checked_sub(1));
            let text = at.and_then(|i| lines.get(i)).copied().unwrap_or_default();
            Hit {
                file: f.to_owned(),
                line: n,
                text: text.to_owned(),
            }
        }));
        Ok(())
    }
}
