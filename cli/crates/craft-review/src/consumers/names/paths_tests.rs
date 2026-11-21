//! The structural search's reading: each path form that reaches a type's or a trait's item
//! matches, and nothing else does.

use super::{Externals, Owner, owner, parse, reaching};

fn lines(text: &str, name: &str, own: &Owner) -> Vec<u32> {
    let tree = parse(text, &mut || false).unwrap();
    reaching(&tree, text, (name, own), &Externals::default())
}

fn typed(name: &str, of_trait: Option<&str>) -> Owner {
    Owner::Type {
        name: name.into(),
        of_trait: of_trait.map(Into::into),
    }
}

fn ty() -> Owner {
    typed("T", None)
}

#[test]
fn each_path_form_through_the_type_matches() {
    let text = "\
use a::T as U;
fn f() {
    T::new();
    a::b::T::new(1);
    T::<u8>::new();
    <T as Tr>::new();
    <T>::new();
    U::new();
    let v = vec![T::new(), 1];
    xs.map(T::new);
}
";
    assert_eq!(
        lines(text, "new", &typed("T", Some("Tr"))),
        vec![3, 4, 5, 6, 7, 8, 9, 10]
    );
}

#[test]
fn self_matches_only_inside_an_impl_of_the_type() {
    let text = "\
impl<X> T<X> {
    fn a() -> Self { Self::new() }
}
impl Tr for a::T {
    fn b() { Self::new(); assert!(Self::new()); }
}
impl Other {
    fn c() -> Self { Self::new() }
}
impl Tr for Other {
    fn d() { Self::new() }
}
fn free() { Self::new() }
";
    assert_eq!(lines(text, "new", &ty()), vec![2, 5]);
}

#[test]
fn a_comment_a_string_a_method_call_and_another_type_s_item_do_not_match() {
    let text = "\
fn f() {
    // T::new()
    /* T::new() */
    let s = \"T::new()\";
    let r = r#\"T::new()\"#;
    let m = HashMap::new();
    let v = Vec::<T>::new();
    let o = <Other as T>::renew();
    x.new();
    T::news();
    format!(\"{}\", Other::new());
    T::other().new();
}
";
    assert_eq!(lines(text, "new", &ty()), Vec::<u32>::new());
}

#[test]
fn a_trait_s_item_is_reached_through_the_trait_and_self_in_its_impls() {
    let text = "\
trait Tr {
    fn update(&self);
    fn twice(&self) { Self::update(self); Self::update(self) }
}
impl Tr for X {
    fn update(&self) {}
    fn again(&self) { Self::update(self) }
}
impl Other for X {
    fn h(&self) { Self::update(self) }
}
fn f(x: X) {
    Tr::update(&x);
    <X as Tr>::update(&x);
    <X as Other>::update(&x);
    X::update(&x);
}
";
    let own = Owner::Trait("Tr".into());
    assert_eq!(lines(text, "update", &own), vec![3, 7, 13, 14]);
}

#[test]
fn the_owner_is_the_impl_s_type_or_the_trait_and_none_for_a_free_item() {
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
}
";
    let tree = parse(text, &mut || false).unwrap();
    let at = |line, name| owner(&tree, text, line, name);
    assert_eq!(at(2, "new"), Some(ty()));
    assert_eq!(at(5, "from"), Some(typed("T", Some("From"))));
    assert_eq!(at(8, "update"), Some(Owner::Trait("Tr".into())));
    assert_eq!(at(10, "run"), None);
    assert_eq!(at(14, "new"), Some(typed("S", None)));
    // A line that declares another name, or no item at all.
    assert_eq!(at(2, "old"), None);
    assert_eq!(at(1, "new"), None);
}

#[test]
fn a_parse_stopped_gives_no_tree() {
    let text = "fn f() {}\n".repeat(10_000);
    assert!(parse(&text, &mut || true).is_none());
}

#[test]
fn a_path_through_an_external_crate_or_its_import_does_not_match() {
    let text = "\
use std::io;
use std::fmt::Error as FmtError;
fn f() {
    std::io::Error::new(k, e);
    ::std::io::Error::new(k, e);
    io::Error::new(k, e);
    core::fmt::Error::new();
    FmtError::new();
    crate::x::Error::new();
    super::Error::new();
    self::inner::Error::new();
    Error::new();
    assert!(std::io::Error::new(k, e).is_ok());
}
";
    let own = typed("Error", None);
    assert_eq!(lines(text, "new", &own), vec![9, 10, 11, 12]);
}

#[test]
fn a_bare_name_imported_from_an_external_crate_is_not_the_owner() {
    let text = "\
use std::io::{self, Error};
fn f() {
    Error::new(k, e);
    crate::Error::new();
}
";
    let own = typed("Error", None);
    assert_eq!(lines(text, "new", &own), vec![4]);
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
    assert_eq!(owner(&tree, text, 2, "update"), None);
    assert_eq!(
        owner(&tree, text, 5, "update"),
        Some(typed("Wrapper", None))
    );
}

#[test]
fn every_call_in_a_macro_s_tokens_matches() {
    let text = "\
impl T {
    fn f() {
        assert_eq!(
            Self::new(),
            Self::new()
        );
    }
}
fn g() {
    let v = vec![
        T::new(),
        T::new(),
    ];
}
";
    assert_eq!(lines(text, "new", &ty()), vec![4, 5, 11, 12]);
}

#[test]
fn a_qualified_path_reaches_the_trait_s_item_not_an_inherent_one() {
    let text = "fn f() {\n    <T as Tr>::new();\n    <T as Other>::new();\n    <T>::new();\n}\n";
    assert_eq!(lines(text, "new", &ty()), vec![4]);
    assert_eq!(lines(text, "new", &typed("T", Some("Tr"))), vec![2, 4]);
}

#[test]
fn a_path_through_a_dependency_of_the_workspace_does_not_match() {
    let text = "fn f() {\n    tokio::sync::Mutex::new(0);\n    sync::Mutex::new(0);\n}\n";
    let tree = parse(text, &mut || false).unwrap();
    let own = typed("Mutex", None);
    let ext = Externals::of(["tokio".to_owned()]);
    assert_eq!(reaching(&tree, text, ("new", &own), &ext), vec![3]);
}
