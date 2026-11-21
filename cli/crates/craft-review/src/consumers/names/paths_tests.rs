//! The structural search's reading: each path form that reaches a type's or a trait's item
//! matches, and nothing else does.

use super::super::unit::{Package, Workspace};
use super::{Item, Kind, Owner, Resolver, parse, reaching};

/// The lines of `text`, the file `file` of `ws`, reaching `name` of `own`; no re-export known.
pub(super) fn lines_in(
    ws: &Workspace,
    file: &str,
    text: &str,
    (name, own): (&str, &Owner),
) -> Vec<u32> {
    let tree = parse(text, &mut || false).unwrap();
    let unit = ws.unit(file);
    let res = Resolver::new(&unit, &tree, text);
    reaching(&tree, text, (name, own), (&res, &|_, _| false))
}

fn lines(text: &str, name: &str, own: &Owner) -> Vec<u32> {
    lines_in(&Workspace::default(), "src/lib.rs", text, (name, own))
}

pub(super) fn item(path: &[&str]) -> Item {
    Item {
        krate: String::new(),
        path: path.iter().map(|s| (*s).to_owned()).collect(),
    }
}

pub(super) fn typed(path: &[&str], of_trait: Option<&str>) -> Owner {
    Owner {
        kind: Kind::Type {
            of_trait: of_trait.map(Into::into),
            also: Vec::new(),
        },
        at: item(path),
    }
}

fn ty() -> Owner {
    typed(&["T"], None)
}

#[test]
fn each_path_form_through_the_type_matches() {
    let text = "\
use a::T as U;
use a::T;
fn f() {
    T::new();
    a::T::new(1);
    T::<u8>::new();
    <T as Tr>::new();
    <T>::new();
    U::new();
    let v = vec![T::new(), 1];
    xs.map(T::new);
}
";
    let own = typed(&["a", "T"], Some("Tr"));
    assert_eq!(lines(text, "new", &own), vec![4, 5, 6, 7, 8, 9, 10, 11]);
}

#[test]
fn self_matches_only_inside_an_impl_of_the_type() {
    let text = "\
impl<X> T<X> {
    fn a() -> Self { Self::new() }
}
impl Tr for crate::T {
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
fn a_trait_s_item_is_reached_through_the_trait_its_implementors_and_self_in_their_impls() {
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
fn f(x: X, y: Y) {
    Tr::update(&x);
    <X as Tr>::update(&x);
    <X as Other>::update(&x);
    X::update(&x);
    Y::update(&y);
}
impl X {
    fn own(&self) { Self::update(self) }
}
";
    let own = Owner {
        kind: Kind::Trait {
            impls: vec![item(&["X"])],
        },
        at: item(&["Tr"]),
    };
    assert_eq!(lines(text, "update", &own), vec![3, 7, 13, 14, 16, 20]);
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
    super::x::Error::new();
    self::Error::new();
    Error::new();
    assert!(std::io::Error::new(k, e).is_ok());
}
";
    let own = typed(&["x", "Error"], None);
    let ws = Workspace::default();
    assert_eq!(
        lines_in(&ws, "src/x.rs", text, ("new", &own)),
        vec![9, 10, 11, 12]
    );
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
    assert_eq!(lines(text, "new", &typed(&["Error"], None)), vec![4]);
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
        crate::T::new(),
        other::T::new(),
    ];
}
";
    assert_eq!(lines(text, "new", &ty()), vec![4, 5, 11, 12]);
}

#[test]
fn a_qualified_path_reaches_the_trait_s_item_not_an_inherent_one() {
    let text = "fn f() {\n    <T as Tr>::new();\n    <T as Other>::new();\n    <T>::new();\n}\n";
    assert_eq!(lines(text, "new", &ty()), vec![4]);
    assert_eq!(lines(text, "new", &typed(&["T"], Some("Tr"))), vec![2, 4]);
}

#[test]
fn a_path_through_a_dependency_of_the_file_s_crate_does_not_match() {
    let text = "fn f() {\n    tokio::sync::Mutex::new(0);\n    sync::Mutex::new(0);\n}\n";
    let ws = Workspace::of(vec![Package {
        dir: String::new(),
        lib: "app".into(),
        has_lib: true,
        deps: ["tokio".to_owned()].into(),
    }]);
    let mut own = typed(&["sync", "Mutex"], None);
    own.at.krate = "app".into();
    assert_eq!(lines_in(&ws, "src/lib.rs", text, ("new", &own)), vec![3]);
}
