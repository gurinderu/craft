//! Whether `Self` at a position is the owner: the nearest `impl` or trait around it.

use tree_sitter::Node;

use super::super::syntax::{segs, text_of};
use super::super::{Kind, same};
use super::Reach;

impl Reach<'_> {
    /// Whether `Self` at `at` is the owner: the nearest `impl` around it is of the type, of the
    /// trait (or, without a trait, of a type implementing it), or the trait around it is it.
    pub(super) fn inside_owner(&self, at: Node<'_>) -> bool {
        let mut up = at.parent();
        while let Some(n) = up {
            match n.kind() {
                "impl_item" => return self.impl_is_owner(n),
                "trait_item" => return self.trait_is_owner(n),
                _ => up = n.parent(),
            }
        }
        false
    }

    /// Whether the `impl` `imp` is the owner's: of its type, or of its trait — or, an inherent
    /// one, of a type implementing it.
    fn impl_is_owner(&self, imp: Node<'_>) -> bool {
        let path = |field: &str| {
            imp.child_by_field_name(field)
                .and_then(|t| segs(t, self.src))
        };
        match &self.own.kind {
            Kind::Type { .. } => {
                path("type").is_some_and(|s| self.lands(&s, imp, self.own.targets()))
            }
            Kind::Trait { impls } => match path("trait") {
                Some(tr) => self.lands(&tr, imp, std::iter::once(&self.own.at)),
                None => path("type").is_some_and(|s| self.lands(&s, imp, impls.iter())),
            },
            Kind::Free => false,
        }
    }

    /// Whether the trait `tr` is the owner.
    fn trait_is_owner(&self, tr: Node<'_>) -> bool {
        let Some(name) = tr.child_by_field_name("name") else {
            return false;
        };
        let mut at = self.res.module_at(tr);
        at.path.push(text_of(name, self.src).to_owned());
        matches!(self.own.kind, Kind::Trait { .. }) && same(&at, &self.own.at, self.rx)
    }
}
