//! What a changed function is declared in, by full path; a free function reached by its module,
//! its imports and its bare name called or passed, and no same-named one elsewhere.

use super::super::unit::Workspace;
use super::tests::{item, lines_in, typed};
use super::{Kind, Owner, Resolver, owner, parse};

fn free(path: &[&str]) -> Owner {
    Owner {
        kind: Kind::Free,
        at: item(path),
    }
}

#[test]
fn the_owner_is_the_impl_s_type_the_trait_or_the_module() {
    let text = "\
impl<X: Clone> a::T<X> {
    pub fn new() -> Self { todo!() }
}
impl From<u8> for T {
    fn from(x: u8) -> Self { todo!() }
}
pub trait Tr {
    fn update(&self);
}
pub fn run() {}
mod m {
    impl S {
        #[inline]
        pub(crate) const fn new() -> S { S }
    }
    fn update() { fn inner() {} }
}
";
    let tree = parse(text, &mut || false).unwrap();
    let ws = Workspace::default();
    let unit = ws.unit("src/x.rs");
    let res = Resolver::new(&unit, &tree, text);
    let at = |line, name| owner(&tree, text, (line, name), &res);
    assert_eq!(at(2, "new"), Some(typed(&["x", "a", "T"], None)));
    assert_eq!(at(5, "from"), Some(typed(&["x", "T"], Some("From"))));
    let tr = Owner {
        kind: Kind::Trait { impls: Vec::new() },
        at: item(&["x", "Tr"]),
    };
    assert_eq!(at(8, "update"), Some(tr));
    assert_eq!(at(10, "run"), Some(free(&["x", "run"])));
    assert_eq!(at(14, "new"), Some(typed(&["x", "m", "S"], None)));
    assert_eq!(at(16, "update"), Some(free(&["x", "m", "update"])));
    // A function inside another's body, a line that declares another name, or no item at all.
    assert_eq!(at(16, "inner"), None);
    assert_eq!(at(2, "old"), None);
    assert_eq!(at(1, "new"), None);
}

#[test]
fn a_blanket_impl_has_no_owner() {
    let text = "\
impl<T: Clone> Ext for T {
    fn update(&self) {}
}
impl<T> Wrapper<T> {
    fn update(&self) {}
}
";
    let tree = parse(text, &mut || false).unwrap();
    let ws = Workspace::default();
    let unit = ws.unit("src/lib.rs");
    let res = Resolver::new(&unit, &tree, text);
    assert_eq!(owner(&tree, text, (2, "update"), &res), None);
    let wrapper = Some(typed(&["Wrapper"], None));
    assert_eq!(owner(&tree, text, (5, "update"), &res), wrapper);
}

#[test]
fn a_free_function_is_reached_by_path_by_import_and_called_or_passed_bare() {
    let text = "\
use crate::h::update;
use crate::h::{self as hh};
fn f() {
    routing::put(update);
    update(1);
    crate::h::update();
    hh::update();
    let u = update;
    x.update();
    other::update();
    s.update = 1;
    tokens!(crate::h::update);
}
mod inner {
    fn g() { update(); super::h::update(); }
}
";
    let own = free(&["h", "update"]);
    let ws = Workspace::default();
    assert_eq!(
        lines_in(&ws, "src/lib.rs", text, ("update", &own)),
        vec![4, 5, 6, 7, 12, 15]
    );
}

#[test]
fn an_implementor_is_no_prelude_type_and_a_glob_s_type_is_its_own() {
    let text = "\
impl Tr for String {}
impl Tr for u8 {}
impl Tr for Mine {}
mod m {
    use crate::a::*;
    impl super::Tr for Foo {}
}
";
    let tree = parse(text, &mut || false).unwrap();
    let ws = Workspace::default();
    let unit = ws.unit("src/lib.rs");
    let res = Resolver::new(&unit, &tree, text);
    let tr = item(&["Tr"]);
    let found = super::implementors(&tree, text, (&tr, &|_, _| false), &res);
    assert_eq!(found, [item(&["Mine"]), item(&["a", "Foo"])]);
}

#[test]
fn a_parse_stopped_gives_no_tree() {
    let text = "fn f() {}\n".repeat(10_000);
    assert!(parse(&text, &mut || true).is_none());
}
