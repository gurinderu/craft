//! A path as written resolved to the items it can name (realm @nick/craft, #564): from the
//! module it is written in, through `crate`, `self` and `super`, a `use` naming its first segment
//! (an alias, `{self as x}`) or a glob of the module it sits in, another crate of the workspace,
//! or none when it leaves the workspace. A `use` path is read without other imports.

use tree_sitter::{Node, Tree};

use super::super::unit::{Root, Unit};
use super::Item;
use super::imports::{Import, imports};
use super::syntax::chain;

/// One file's resolution of paths.
pub(in crate::consumers::names) struct Resolver<'a> {
    unit: &'a Unit<'a>,
    src: &'a str,
    imports: Vec<Import>,
}

impl<'a> Resolver<'a> {
    pub(in crate::consumers::names) fn new(unit: &'a Unit<'a>, tree: &Tree, src: &'a str) -> Self {
        Self {
            unit,
            src,
            imports: imports(tree, src),
        }
    }

    /// The module path of the position `at`: the file's module and the inline modules around it.
    pub(super) fn module_at(&self, at: Node<'_>) -> Item {
        let mut path = self.unit.module.clone();
        path.extend(chain(at, self.src));
        Item {
            krate: self.unit.krate.clone(),
            path,
        }
    }

    /// The items the path `segs`, written at `at`, can name: one for a path through `crate`,
    /// `self`, `super`, a `use` or another crate; for one relative to the module, also the items
    /// each glob there can bring in; none for one leaving the workspace.
    pub(super) fn resolve(&self, at: Node<'_>, segs: &[&str]) -> Vec<Item> {
        self.resolve_in(&chain(at, self.src), segs, true)
    }

    fn resolve_in(&self, chain: &[String], segs: &[&str], through_uses: bool) -> Vec<Item> {
        let Some((&first, rest)) = segs.split_first() else {
            return Vec::new();
        };
        let mut module = self.unit.module.clone();
        module.extend(chain.iter().cloned());
        match first {
            "crate" => vec![item(&self.unit.krate, Vec::new(), rest)],
            "self" => vec![item(&self.unit.krate, module, rest)],
            "super" => {
                let ups = segs.iter().take_while(|s| **s == "super").count();
                let Some(keep) = module.len().checked_sub(ups) else {
                    return Vec::new();
                };
                module.truncate(keep);
                vec![item(
                    &self.unit.krate,
                    module,
                    segs.get(ups..).unwrap_or_default(),
                )]
            }
            _ if through_uses => self.through_uses(chain, module, segs),
            _ => self.by_root(module, segs),
        }
    }

    /// A path whose first segment a `use` in its module may bind: that `use`'s path, else the
    /// path from its root and through each glob there.
    fn through_uses(&self, chain: &[String], module: Vec<String>, segs: &[&str]) -> Vec<Item> {
        let here = || self.imports.iter().filter(|i| i.chain == chain);
        let first = segs.first().copied();
        if let Some(i) = here().find(|i| i.local.as_deref() == first) {
            return self.resolve_in(
                &i.chain,
                &joined(&i.path, segs.get(1..).unwrap_or_default()),
                false,
            );
        }
        let mut out = self.by_root(module, segs);
        for g in here().filter(|i| i.local.is_none()) {
            out.extend(self.resolve_in(&g.chain, &joined(&g.path, segs), false));
        }
        out
    }

    /// A path from its first segment: another crate, out of the workspace, or this module's.
    fn by_root(&self, module: Vec<String>, segs: &[&str]) -> Vec<Item> {
        let Some((&first, rest)) = segs.split_first() else {
            return Vec::new();
        };
        match self.unit.root(first) {
            Root::Out => Vec::new(),
            Root::Crate(c) => vec![item(&c, Vec::new(), rest)],
            Root::Here => vec![item(&self.unit.krate, module, segs)],
        }
    }
}

/// The item `rest` names under `path` of the crate `krate`.
fn item(krate: &str, mut path: Vec<String>, rest: &[&str]) -> Item {
    path.extend(rest.iter().map(|s| (*s).to_owned()));
    Item {
        krate: krate.to_owned(),
        path,
    }
}

/// `path` followed by `rest`, as segments.
fn joined<'p>(path: &'p [String], rest: &[&'p str]) -> Vec<&'p str> {
    path.iter()
        .map(String::as_str)
        .chain(rest.iter().copied())
        .collect()
}
