use super::{Owner, names_as, owner};

fn lines(s: &str) -> Vec<String> {
    s.lines().map(str::to_owned).collect()
}

#[test]
fn the_owner_is_the_header_of_the_nearest_less_indented_line() {
    let src = lines(
        "pub fn free() {}\n\nimpl<'a> Group<'a> {\n    pub fn of() {}\n}\n\nimpl fmt::Display for a::Rule<T> {\n    fn fmt() {}\n}\n\npub trait Judge {\n    fn judge(&self);\n}\n\nmod m {\n    pub fn inner() {}\n}\n\npub(crate) trait Status: Base {\n    fn conditions(&self);\n}\n\nunsafe impl Send for Ring {\n    fn f() {}\n}\n",
    );
    assert_eq!(owner(&src, 1), Owner::Free);
    assert_eq!(owner(&src, 4), Owner::Impl(vec!["Group".into()]));
    assert_eq!(
        owner(&src, 8),
        Owner::Impl(vec!["Display".into(), "Rule".into()])
    );
    assert_eq!(owner(&src, 12), Owner::Trait);
    assert_eq!(owner(&src, 16), Owner::Free);
    assert_eq!(owner(&src, 20), Owner::Trait);
    assert_eq!(
        owner(&src, 24),
        Owner::Impl(vec!["Send".into(), "Ring".into()])
    );
    assert_eq!(owner(&src, 99), Owner::Unknown);
}

#[test]
fn another_type_s_item_of_the_name_does_not_reach_a_method() {
    let own = Owner::Impl(vec!["Group".into()]);
    assert!(!names_as("let m = HashMap::new();", "new", &own));
    assert!(!names_as("let (m, v) = MockServer::new();", "new", &own));
    assert!(names_as("let g = Group::new();", "new", &own));
    assert!(names_as("Self::new()", "new", &own));
    assert!(names_as("group.new(top)", "new", &own));
    assert!(names_as("HashMap::new(); Group::new()", "new", &own));
    assert!(!names_as("if !owns(&sg) {", "owns", &own));
    assert!(!names_as("let of = |required| Restart {", "of", &own));
}

#[test]
fn a_method_call_or_a_type_s_path_does_not_reach_a_free_function() {
    let own = Owner::Free;
    assert!(!names_as("hasher.update(&bytes);", "update", &own));
    assert!(!names_as("Sha256::update(x)", "update", &own));
    assert!(names_as("update(x)", "update", &own));
    assert!(names_as("crate::api::m::update(x)", "update", &own));
    assert!(names_as(".map(update)", "update", &own));
    assert!(!names_as("updated(x)", "update", &own));
}

#[test]
fn a_trait_s_item_or_an_unread_owner_takes_every_line_naming_it() {
    assert!(names_as("x.judge()", "judge", &Owner::Trait));
    assert!(names_as("Other::judge(x)", "judge", &Owner::Trait));
    assert!(names_as("hasher.update(x)", "update", &Owner::Unknown));
}
