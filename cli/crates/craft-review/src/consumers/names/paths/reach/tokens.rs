//! The paths in a macro's tokens, which the grammar leaves unparsed.

use tree_sitter::Node;

use super::super::syntax::text_of;
use super::Reach;

/// Whether a token can be a path's segment.
fn is_segment(k: Node<'_>) -> bool {
    matches!(k.kind(), "identifier" | "self" | "super" | "crate")
}

impl Reach<'_> {
    /// The rows of each `a :: b :: name` in the token tree `n` whose qualifier reaches the item; a
    /// bare name in a macro's tokens is not read.
    pub(super) fn in_tokens(&self, n: Node<'_>) -> Vec<usize> {
        let mut c = n.walk();
        let kids: Vec<Node<'_>> = n.children(&mut c).collect();
        let is = |i: usize, kind: &str| kids.get(i).is_some_and(|k| k.kind() == kind);
        let seg = |i: usize| kids.get(i).is_some_and(|k| is_segment(*k));
        let text = |i: usize| kids.get(i).map_or("", |k| text_of(*k, self.src));
        let mut rows = Vec::new();
        for i in 0..kids.len() {
            let shaped = seg(i) && is(i + 1, "::") && is(i + 2, "identifier");
            if !shaped || text(i + 2) != self.name {
                continue;
            }
            // Back to the path's first segment, across `seg ::` pairs.
            let mut j = i;
            while j >= 2 && is(j - 1, "::") && seg(j - 2) {
                j -= 2;
            }
            let rooted = j > 0 && is(j - 1, "::");
            let segs: Vec<&str> = rooted
                .then_some("::")
                .into_iter()
                .chain((j..=i).step_by(2).map(text))
                .collect();
            if let Some(k) = kids.get(i).filter(|_| self.qualifier(&segs, n)) {
                rows.push(k.start_position().row);
            }
        }
        rows
    }
}
