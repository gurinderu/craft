//! The type names a file declares, each in its inline module, and the standard prelude's names,
//! which a path reaches only where the crate declares a type of that name (realm @nick/craft,
//! #564).

use tree_sitter::Tree;

use super::syntax::{chain, text_of, walk};

/// The names every module sees from the standard library's prelude and its primitive types.
const PRELUDE: [&str; 45] = [
    "Option",
    "Some",
    "None",
    "Result",
    "Ok",
    "Err",
    "String",
    "Vec",
    "Box",
    "ToString",
    "ToOwned",
    "Iterator",
    "IntoIterator",
    "DoubleEndedIterator",
    "ExactSizeIterator",
    "Extend",
    "Default",
    "Clone",
    "Copy",
    "Send",
    "Sync",
    "Sized",
    "Drop",
    "From",
    "Into",
    "TryFrom",
    "TryInto",
    "AsRef",
    "AsMut",
    "PartialEq",
    "Eq",
    "PartialOrd",
    "Ord",
    "Fn",
    "FnMut",
    "FnOnce",
    "str",
    "bool",
    "char",
    "u8",
    "u32",
    "u64",
    "usize",
    "i32",
    "i64",
];

/// Whether `name` is one of the standard prelude's names.
pub(super) fn in_prelude(name: &str) -> bool {
    PRELUDE.contains(&name)
}

/// The type names (structs, enums, unions, aliases, traits) `tree` declares, each with the inline
/// modules around it.
pub(super) fn declared(tree: &Tree, src: &str) -> Vec<(Vec<String>, String)> {
    let mut out = Vec::new();
    walk(tree.root_node(), |n| {
        let is_type = matches!(
            n.kind(),
            "struct_item" | "enum_item" | "union_item" | "type_item" | "trait_item"
        );
        if let Some(name) = n.child_by_field_name("name").filter(|_| is_type) {
            out.push((chain(n, src), text_of(name, src).to_owned()));
        }
    });
    out
}
