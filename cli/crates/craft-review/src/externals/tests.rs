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
fn list_precedence_and_invalid_arguments() {
    let input = js::parse(r#"{"externals":[],"records":[1]}"#).unwrap();
    assert_eq!(super::record_list(&input).unwrap().len(), 0);
    let input = js::parse(r#"{"externals":1,"records":[1]}"#).unwrap();
    assert_eq!(super::record_list(&input).unwrap().len(), 1);
    for argv in [
        vec![],
        vec!["--help"],
        vec!["prepare"],
        vec!["discover", "--repo-root"],
        vec!["discover", "--repo-root", "relative"],
        vec!["memory", "--repo-root", "relative"],
        vec!["discover", "--repo-root", "/x", "--known", "f"],
        vec!["discover", "--repo-root", "/x", "--paths", "not-b64!"],
        vec!["discover", "--repo-root", "/x", "--paths", "WyIuLi94Il0"],
        vec!["discover", "--repo-root", "/x", "--repo-root", "/y"],
        vec!["discover", "--repo-root", "/x", "--bogus", "1"],
    ] {
        assert!(
            super::Invocation::parse(&argv.iter().map(|s| (*s).into()).collect::<Vec<_>>())
                .is_err(),
            "{argv:?}"
        );
    }
}

#[test]
fn base64_accepts_unused_bits_and_a_discarded_trailing_sextet() {
    let root = tempfile::tempdir().unwrap();
    for encoded in ["WyJ4Il0", "WyJ4Il1", "WyJ4Il0A"] {
        // The final sextet is discarded only when the complete encoding length is 1 mod 4.
        let args = vec![
            "discover".into(),
            "--repo-root".into(),
            root.path().display().to_string(),
            "--paths".into(),
            encoded.into(),
        ];
        let got = super::Invocation::parse(&args);
        if encoded == "WyJ4Il0A" {
            assert!(got.is_err());
        } else {
            assert_eq!(got.unwrap().paths.unwrap(), vec!["x"]);
        }
    }
}
