//! What a module of one file has in scope: its `use` declarations, its globs and the types it
//! declares, and the types an `impl` there can be.

use tree_sitter::Node;

use super::super::Item;
use super::super::imports::Import;
use super::super::syntax::chain;
use super::{Resolver, joined};

impl Resolver<'_> {
    /// The items the type `segs` of an `impl`, written at `at`, can be: a single name neither
    /// declared in its module nor imported by name is what the module's globs bring in, when
    /// any does; otherwise as [`Self::resolve`] has it.
    pub(in crate::consumers::names::paths) fn type_candidates(
        &self,
        at: Node<'_>,
        segs: &[&str],
    ) -> Vec<Item> {
        let chain = chain(at, self.src);
        if let [one] = segs {
            let named = self.here(&chain).any(|i| i.local.as_deref() == Some(*one));
            let globs = self.globs(&chain, segs);
            if !named && !self.declares(&chain, one) && !globs.is_empty() {
                return globs;
            }
        }
        self.resolve_in(&chain, segs, true)
    }

    pub(super) fn here<'s>(&'s self, chain: &'s [String]) -> impl Iterator<Item = &'s Import> {
        self.imports.iter().filter(move |i| i.chain == chain)
    }

    /// The items `segs` can name through each glob of the module `chain`.
    pub(super) fn globs(&self, chain: &[String], segs: &[&str]) -> Vec<Item> {
        let mut out = Vec::new();
        for g in self.here(chain).filter(|i| i.local.is_none()) {
            out.extend(self.resolve_in(&g.chain, &joined(&g.path, segs), false));
        }
        out
    }

    /// Whether the file declares a type `name` in the module `chain`.
    pub(super) fn declares(&self, chain: &[String], name: &str) -> bool {
        self.declared.iter().any(|(c, n)| c == chain && n == name)
    }
}
