//! What a changed symbol is declared in, and whether a graph caller's line names it in a form
//! that can reach it (realm @nick/craft, node #530). The graph binds a call it cannot resolve —
//! `HashMap::new()`, `hasher.update(…)`, `MockServer::new()` — to a same-named function of the
//! project, at any confidence (`suffix_match` at 0.02–0.55, `lsp_short_name_unique` at 0.90, while
//! a resolved `crate::api::m::f(…)` can stand at 0.28), so the edge's own callee is the symbol and
//! only the line tells the call apart.

use super::super::names;

/// What a symbol is declared in, read from the lines of its file in head.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Owner {
    /// Nothing: a free item, which no method call and no type's path reaches.
    Free,
    /// An `impl` block: the types its header names (the implementing type, and the trait).
    Impl(Vec<String>),
    /// A trait, whose items any implementing type's path reaches.
    Trait,
    /// Its file could not be read: every line naming it is taken.
    Unknown,
}

fn indent(s: &str) -> usize {
    s.len() - s.trim_start().len()
}

/// The owner of the item declared at `line` (1-based) of `lines`: the header of the nearest
/// less-indented line above it.
pub(super) fn owner(lines: &[String], line: u32) -> Owner {
    let Some(at) = usize::try_from(line).ok().and_then(|l| l.checked_sub(1)) else {
        return Owner::Unknown;
    };
    let Some(own) = lines.get(at) else {
        return Owner::Unknown;
    };
    let depth = indent(own);
    let above = lines.get(..at).unwrap_or_default().iter().rev();
    let header = above
        .filter(|l| !l.trim().is_empty())
        .find(|l| indent(l) < depth);
    match header.map(|h| unqualified(h.trim_start())) {
        Some(h) if h.starts_with("trait ") => Owner::Trait,
        Some(h) => impl_types(h).map_or(Owner::Free, Owner::Impl),
        None => Owner::Free,
    }
}

/// A header past its visibility (`pub`, `pub(crate)`, `pub(in a::b)`) and `unsafe`.
fn unqualified(h: &str) -> &str {
    let h = match h.strip_prefix("pub(") {
        Some(rest) => rest.split_once(')').map_or(rest, |(_, r)| r),
        None => h.strip_prefix("pub ").unwrap_or(h),
    };
    let h = h.trim_start();
    h.strip_prefix("unsafe ").unwrap_or(h).trim_start()
}

/// The types an `impl` header names, each by its last path segment; `None` when `h` is not one.
fn impl_types(h: &str) -> Option<Vec<String>> {
    let rest = h.strip_prefix("impl")?;
    let rest = skip_generics(rest)?;
    let body = rest.split(['{', '\n']).next().unwrap_or_default();
    let body = body.split(" where ").next().unwrap_or_default();
    let types = body.split(" for ").filter_map(base).collect::<Vec<_>>();
    (!types.is_empty()).then_some(types)
}

/// `s` past a leading `<…>` (balanced); `None` when `s` does not go on with a space or `<`.
fn skip_generics(s: &str) -> Option<&str> {
    if !s.starts_with('<') {
        return s.starts_with(' ').then_some(s);
    }
    let mut depth = 0usize;
    for (i, c) in s.char_indices() {
        match c {
            '<' => depth += 1,
            '>' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return s.get(i + 1..);
                }
            }
            _ => {}
        }
    }
    None
}

/// The last path segment of a type as written (`&mut a::Foo<T>` is `Foo`).
fn base(t: &str) -> Option<String> {
    let t = t.trim().trim_start_matches('&').trim_start_matches("mut ");
    let t = t.trim_start_matches("dyn ").trim();
    let path = t.split(['<', ' ']).next()?;
    let last = path.rsplit("::").next()?;
    (!last.is_empty()).then(|| last.to_owned())
}

/// Whether `text` names `name` in a form that can reach an item `owner` declares: a path
/// through a type its `impl` names (or `Self`), or through a module for a free item; a method
/// call for an item of an `impl`; or, for a free item, the name alone (an `impl`'s item is never
/// reached by its bare name, which there is a local or another item). A trait's item, or one
/// whose owner was not read, is taken wherever the line names it.
pub(super) fn names_as(text: &str, name: &str, owner: &Owner) -> bool {
    if matches!(owner, Owner::Unknown | Owner::Trait) {
        return names::names(text, name);
    }
    let ident = |c: char| c.is_ascii_alphanumeric() || c == '_';
    text.match_indices(name).any(|(i, _)| {
        let before = text.get(..i).unwrap_or_default();
        let after = text.get(i + name.len()..).unwrap_or_default();
        if before.chars().next_back().is_some_and(ident) || after.chars().next().is_some_and(ident)
        {
            return false;
        }
        reaches(before.trim_end(), owner)
    })
}

/// Whether a mention of the name after `before` reaches an item of `owner`.
fn reaches(before: &str, owner: &Owner) -> bool {
    if let Some(path) = before.strip_suffix("::") {
        let qualifier: String = path
            .chars()
            .rev()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        let is_type = qualifier.starts_with(|c: char| c.is_ascii_uppercase());
        return match owner {
            Owner::Impl(types) => qualifier == "Self" || types.contains(&qualifier),
            // A turbofish or a generic path before it cannot be read: taken.
            Owner::Free => !is_type || qualifier.is_empty(),
            Owner::Trait | Owner::Unknown => true,
        };
    }
    let free = matches!(owner, Owner::Free);
    if before.ends_with('.') {
        return !free;
    }
    free
}

#[cfg(test)]
#[path = "owner_tests.rs"]
mod tests;
