//! The paths in a macro's tokens, which the grammar leaves unparsed.

use tree_sitter::Node;

use super::super::text_of;
use super::Reach;

impl Reach<'_> {
    /// The rows of each `Owner :: name` in the token tree `n`, which the grammar leaves unparsed;
    /// a path through another crate (`std :: io :: Error :: new`) left out.
    pub(super) fn in_tokens(&self, n: Node<'_>) -> Vec<usize> {
        let mut c = n.walk();
        let kids: Vec<Node<'_>> = n.children(&mut c).collect();
        let is = |i: usize, kind: &str| kids.get(i).is_some_and(|k| k.kind() == kind);
        let text = |i: usize| kids.get(i).map_or("", |k| text_of(*k, self.src));
        let mut rows = Vec::new();
        for i in 0..kids.len() {
            let shaped = is(i, "identifier") && is(i + 1, "::") && is(i + 2, "identifier");
            if !shaped || text(i + 2) != self.name {
                continue;
            }
            // Back to the path's first segment, across `seg ::` pairs.
            let mut j = i;
            while j >= 2 && is(j - 1, "::") && !is(j - 2, "::") && !is(j - 2, "token_tree") {
                j -= 2;
            }
            let start = if j > 0 && is(j - 1, "::") {
                Some("::")
            } else {
                (j < i).then(|| text(j))
            };
            if let Some(k) = kids.get(i).filter(|_| self.names_owner(text(i), start, n)) {
                rows.push(k.start_position().row);
            }
        }
        rows
    }
}
