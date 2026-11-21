//! The structural search's reading: each path form that reaches a type's or a trait's item
//! matches, and nothing else does.

use super::{Owner, owner, parse, reaching};

fn lines(text: &str, name: &str, own: &Owner) -> Vec<u32> {
    let tree = parse(text, &mut || false).unwrap();
    reaching(&tree, text, name, own)
}

fn ty() -> Owner {
    Owner::Type("T".into())
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
    assert_eq!(lines(text, "new", &ty()), vec![3, 4, 5, 6, 7, 8, 9, 10]);
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
    assert_eq!(at(5, "from"), Some(ty()));
    assert_eq!(at(8, "update"), Some(Owner::Trait("Tr".into())));
    assert_eq!(at(10, "run"), None);
    assert_eq!(at(14, "new"), Some(Owner::Type("S".into())));
    // A line that declares another name, or no item at all.
    assert_eq!(at(2, "old"), None);
    assert_eq!(at(1, "new"), None);
}

#[test]
fn a_parse_stopped_gives_no_tree() {
    let text = "fn f() {}\n".repeat(10_000);
    assert!(parse(&text, &mut || true).is_none());
}
