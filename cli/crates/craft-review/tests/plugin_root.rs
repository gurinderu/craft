//! Where a binary finds the plugin root its prompts name: an installed copy holds the manifest at its
//! root, a checkout holds it in its Claude Code delivery, `integrations/claude-code`.
#![expect(
    clippy::unwrap_used,
    reason = "the fixture helpers fail the test loudly, like the tests they serve"
)]

use std::path::Path;

use craft_review::prompts::{craft_root_near, plugin_root_at};

fn manifest(dir: &Path, version: &str) {
    std::fs::create_dir_all(dir.join(".claude-plugin")).unwrap();
    std::fs::write(
        dir.join(".claude-plugin/plugin.json"),
        format!(r#"{{"name":"craft","version":"{version}"}}"#),
    )
    .unwrap();
}

#[test]
fn an_installed_copy_is_its_own_root() {
    let d = tempfile::tempdir().unwrap();
    manifest(d.path(), "1.2.3");
    assert_eq!(plugin_root_at(d.path()), Some(d.path().to_path_buf()));
    let bin = d.path().join("bin/x");
    let (root, version) = craft_root_near(&bin).unwrap();
    assert_eq!(root, d.path().display().to_string());
    assert_eq!(version.as_deref(), Some("1.2.3"));
}

#[test]
fn a_checkout_names_its_claude_code_delivery() {
    let d = tempfile::tempdir().unwrap();
    let delivery = d.path().join("integrations/claude-code");
    manifest(&delivery, "4.5.6");
    assert_eq!(plugin_root_at(d.path()), Some(delivery.clone()));
    let exe = d.path().join("cli/target/debug/craft");
    let (root, version) = craft_root_near(&exe).unwrap();
    assert_eq!(root, delivery.display().to_string());
    assert_eq!(version.as_deref(), Some("4.5.6"));
}

#[test]
fn no_manifest_is_no_root() {
    let d = tempfile::tempdir().unwrap();
    assert_eq!(plugin_root_at(d.path()), None);
    assert_eq!(craft_root_near(&d.path().join("x")), None);
}
