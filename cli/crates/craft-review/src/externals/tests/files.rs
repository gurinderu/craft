use super::{discover, import, put};
use serde_json::json;

#[test]
fn containment_file_limits_replacement_decoding_and_normalized_paths() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    put(&root, "d/v", b"\xfftag: v1\n");
    let input = |file: &str, pattern: &str| json!([{"system":"a","repo":"r","versionFrom":file,"versionMatch":pattern}]);
    for path in [
        "d/v".into(),
        "d/../d/v".into(),
        root.join("d/v").display().to_string(),
    ] {
        let got = import(&root, input(&path, "\u{fffd}tag: (v1)"));
        assert_eq!(got["candidates"][0]["ref"], "v1");
    }
    for (file, why) in [
        ("../outside", "versionFrom resolves outside the repository"),
        ("missing", "versionFrom missing not found"),
        ("d", "versionFrom d is not a file of at most 4194304 bytes"),
    ] {
        assert_eq!(
            import(&root, input(file, "(v1)"))["refused"][0],
            format!("external record a: {why}")
        );
    }
    let mut bytes = b"image: x/y:v1\n#".to_vec();
    bytes.resize(1024 * 1024, b'x');
    put(&root, "values.yaml", &bytes);
    assert_eq!(
        discover(&root, None, json!([]))["candidates"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    bytes.push(b'x');
    put(&root, "values.yaml", &bytes);
    assert_eq!(
        discover(&root, None, json!([]))["unread"][0]["error"],
        "manifest values.yaml is not a file of at most 1048576 bytes"
    );
    bytes.resize(4 * 1024 * 1024, b'x');
    put(&root, "v", &bytes);
    assert_eq!(
        import(&root, input("v", "(v1)"))["candidates"][0]["ref"],
        "v1"
    );
    bytes.push(b'x');
    put(&root, "v", &bytes);
    assert_eq!(
        import(&root, input("v", "(v1)"))["refused"][0],
        "external record a: versionFrom v is not a file of at most 4194304 bytes"
    );
}

#[test]
#[cfg(unix)]
fn explicit_paths_follow_inside_symlinks_and_walk_does_not() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("repo");
    put(&root, "inside/values.yaml", "image: x/y:v1\n");
    put(temp.path(), "outside", "image: x/y:v9\n");
    symlink(root.join("inside/values.yaml"), root.join("values.yaml")).unwrap();
    symlink(root.join("inside"), root.join("link")).unwrap();
    symlink(temp.path().join("outside"), root.join("out.yaml")).unwrap();
    symlink(root.join("absent"), root.join("gone.yaml")).unwrap();
    assert_eq!(
        discover(&root, None, json!([]))["candidates"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let got = discover(
        &root,
        Some(&["values.yaml", "link/values.yaml", "out.yaml", "gone.yaml"]),
        json!([]),
    );
    assert_eq!(got["candidates"].as_array().unwrap().len(), 2);
    assert_eq!(
        got["unread"][0]["error"],
        "manifest resolves outside the repository"
    );
    assert_eq!(got["unread"][1]["error"], "manifest gone.yaml not found");
}

#[test]
#[cfg(unix)]
fn unlistable_directory_is_silently_skipped() {
    use std::os::unix::fs::PermissionsExt;
    if nix::unistd::geteuid().is_root() {
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    put(temp.path(), "locked/values.yaml", "image: x/y:v1\n");
    std::fs::set_permissions(
        temp.path().join("locked"),
        std::fs::Permissions::from_mode(0o0),
    )
    .unwrap();
    let got = discover(temp.path(), None, json!([]));
    std::fs::set_permissions(
        temp.path().join("locked"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    assert_eq!(got, json!({"candidates":[],"more":0,"unread":[]}));
}

#[test]
#[cfg(unix)]
fn file_permission_failure_remains_visible_in_discovery_and_import() {
    use std::os::unix::fs::PermissionsExt;
    if nix::unistd::geteuid().is_root() {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    put(root.path(), "values.yaml", "image: x/y:v1\n");
    let file = root.path().join("values.yaml");
    let resolved = file.canonicalize().unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o0)).unwrap();
    let found = discover(root.path(), None, json!([]));
    let imported = import(
        root.path(),
        json!([{"system":"y", "repo":"r", "versionFrom":"values.yaml", "versionMatch":"(v1)"}]),
    );
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(found["candidates"], json!([]));
    assert_eq!(found["unread"].as_array().unwrap().len(), 1);
    assert_eq!(found["unread"][0]["file"], "values.yaml");
    assert!(!found["unread"][0]["error"].as_str().unwrap().is_empty());
    assert_eq!(imported["candidates"], json!([]));
    assert!(
        imported["refused"][0]
            .as_str()
            .unwrap()
            .starts_with("external record y: ")
    );
    for error in [&found["unread"][0]["error"], &imported["refused"][0]] {
        let error = error.as_str().unwrap();
        assert!(error.contains(&resolved.display().to_string()), "{error}");
        assert!(error.contains("read"), "{error}");
        assert!(
            error.to_ascii_lowercase().contains("permission denied"),
            "{error}"
        );
    }
}
