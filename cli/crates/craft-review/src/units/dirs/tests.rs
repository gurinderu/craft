use super::*;

fn files(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_owned()).collect()
}

#[test]
fn a_shared_file_rides_on_every_slice_and_small_changes_are_not_sliced() {
    let not_toml = |f: &str| !is_shared(f);
    assert!(slice_diff(&files(&["a/x.rs", "b/y.rs"]), 12, 6, &not_toml).is_empty());
    let fs: Vec<String> = (0..12)
        .map(|i| format!("{}/m/f{i}.rs", if i % 2 == 0 { "a" } else { "b" }))
        .chain(["Cargo.toml".to_owned()])
        .collect();
    let slices = slice_diff(&fs, 12, 6, &not_toml);
    assert_eq!(slices.len(), 2);
    assert!(
        slices
            .iter()
            .all(|s| s.files.contains(&"Cargo.toml".to_owned()))
    );
    assert_eq!(group_key("a.rs", 2), ".");
    assert_eq!(group_key("a/b/c.rs", 2), "a/b");
}
