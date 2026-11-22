mod cost;
mod files;
mod manifests;
mod memory;
mod origin;
mod policy;
mod regex;
mod shapes;
mod validation;
mod walk;

use craft_store::js::{self, Js};
use serde_json::Value;
use std::path::Path;

fn put(root: &Path, file: &str, value: impl AsRef<[u8]>) {
    let path = root.join(file);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, value).unwrap();
}

#[expect(
    clippy::needless_pass_by_value,
    reason = "fixture adapters consume temporary JSON at call sites"
)]
fn json(value: Js) -> Value {
    Value::try_from(&value).unwrap()
}

#[expect(
    clippy::needless_pass_by_value,
    reason = "fixture adapters consume temporary JSON at call sites"
)]
fn import(root: &Path, value: Value) -> Value {
    json(super::import(root, &Js::from(&value)).unwrap())
}

#[expect(
    clippy::needless_pass_by_value,
    reason = "fixture adapters consume temporary JSON at call sites"
)]
fn discover(root: &Path, paths: Option<&[&str]>, known: Value) -> Value {
    let paths = paths.map(|p| p.iter().map(|s| (*s).into()).collect::<Vec<_>>());
    let known = Js::from(&known);
    json(super::discover(root, paths.as_deref(), known.as_arr().unwrap()).unwrap())
}

#[test]
fn list_precedence() {
    let input = js::parse(r#"{"externals":[],"records":[1]}"#).unwrap();
    assert_eq!(super::record_list(&input).unwrap().len(), 0);
    let input = js::parse(r#"{"externals":1,"records":[1]}"#).unwrap();
    assert_eq!(super::record_list(&input).unwrap().len(), 1);
}
