//! What the structural search reads around a changed item besides its callers' files: the types
//! implementing a changed trait's item, and whether an enclosing module re-exports a name.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::path::Path;

use super::super::super::source;
use super::super::paths::{self, Item, Reexports, Resolver};
use super::super::unit::Workspace;
use super::files::naming;
use super::{Until, parse_until};

/// How many types implementing a trait are searched through.
const IMPLS_MAX: usize = 32;

/// The types the workspace at `top` implements the trait at `trait_at` for, read from the files
/// naming it, read until [`IMPLS_MAX`] are found.
pub(super) fn implemented(
    top: &Path,
    ws: &Workspace,
    (trait_at, rx): (&Item, Reexports<'_>),
    until: Until<'_>,
) -> Result<Vec<Item>, String> {
    let Some(word) = trait_at.path.last() else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for f in naming(top, &["impl", word], until)? {
        let Ok(Some(text)) = source::read_within(top, &f) else {
            continue;
        };
        let tree = parse_until(&text, until)?;
        let unit = ws.unit(&f);
        let res = Resolver::new(&unit, &tree, &text);
        out.extend(paths::implementors(&tree, &text, (trait_at, rx), &res));
        out.sort();
        out.dedup();
        if out.len() >= IMPLS_MAX {
            out.truncate(IMPLS_MAX);
            break;
        }
    }
    Ok(out)
}

/// Whether a module's file brings a name in by a `use` and declares no item of it, each module
/// read once.
pub(super) struct Reexported<'a> {
    top: &'a Path,
    ws: &'a Workspace,
    until: Until<'a>,
    seen: RefCell<BTreeMap<(Item, String), bool>>,
}

impl<'a> Reexported<'a> {
    pub(super) fn new(top: &'a Path, ws: &'a Workspace, until: Until<'a>) -> Self {
        Self {
            top,
            ws,
            until,
            seen: RefCell::default(),
        }
    }

    /// Whether the module `module` re-exports `name`: the first of its files there is brings
    /// `name` in by a `use` (by name, or a glob) and declares no item of it.
    pub(super) fn brings(&self, module: &Item, name: &str) -> bool {
        let key = (module.clone(), name.to_owned());
        if let Some(known) = self.seen.borrow().get(&key) {
            return *known;
        }
        let files = self.ws.files_of(&module.krate, &module.path);
        let read = files
            .iter()
            .find_map(|f| source::read_within(self.top, f).ok()?);
        let tree = read.as_ref().and_then(|t| parse_until(t, self.until).ok());
        let found = match (read, tree) {
            (Some(text), Some(tree)) => paths::reexports(&tree, &text, name),
            _ => false,
        };
        self.seen.borrow_mut().insert(key, found);
        found
    }
}
