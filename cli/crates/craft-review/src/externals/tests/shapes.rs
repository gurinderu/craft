use super::super::{manifest, pattern::Engine};
use super::{discover, put};
use serde_json::json;

#[test]
fn every_legacy_manifest_filename_has_its_original_parser() {
    let root = tempfile::tempdir().unwrap();
    for (file, body) in [
        (
            "charts/a/Chart.yaml",
            "name: app\nappVersion: v1\nsources:\n- https://github.com/a/app\n",
        ),
        ("charts/a/values.yaml", "image: x/app:v1\n"),
        ("values-prod.yml", "image: x/app:v1\n"),
        (
            "k/kustomization.yaml",
            "images:\n- name: app\n  newTag: v1\n",
        ),
        ("k/Kustomization", "images:\n- name: app\n  newTag: v1\n"),
        ("docker-compose.yml", "image: x/app:v1\n"),
        ("deploy/compose.prod.yaml", "image: x/app:v1\n"),
        (
            "infra/main.tf",
            "source = \"git::https://github.com/a/app?ref=v1\"\n",
        ),
        (
            "k8s/deployment.yaml",
            "apiVersion: v1\nkind: Deployment\nimage: x/app:v1\n",
        ),
    ] {
        put(root.path(), file, body);
        let got = discover(root.path(), Some(&[file]), json!([]));
        assert_eq!(
            got["candidates"].as_array().unwrap().len(),
            1,
            "{file}: {got}"
        );
        assert_eq!(got["candidates"][0]["system"], "app", "{file}");
        assert_eq!(got["candidates"][0]["version"], "v1", "{file}");
    }
    for file in [
        ".github/workflows/ci.yml",
        "charts/a/templates/deploy.yaml",
        "pnpm-lock.yaml",
        "Cargo.lock",
        "go.sum",
        "package-lock.json",
        "flake.lock",
        "nix/flake.lock",
        "src/main.rs",
        "README.md",
    ] {
        put(
            root.path(),
            file,
            "apiVersion: v1\nkind: Pod\nimage: x/app:v1\n",
        );
        assert_eq!(
            discover(root.path(), Some(&[file]), json!([]))["candidates"],
            json!([]),
            "{file}"
        );
    }
}

#[test]
fn registry_repository_tag_and_subimage_guess_are_retained() {
    let root = tempfile::tempdir().unwrap();
    put(
        root.path(),
        "values.yaml",
        "image:\n  registry: ghcr.io\n  repository: kubeovn/kube-ovn\n  tag: v1.12.3\nlone:\n  repository: a/b\nother:\n  image: ghcr.io/kubeovn/kube-ovn/sub:v2\n",
    );
    let got = discover(root.path(), None, json!([]));
    assert_eq!(got["candidates"].as_array().unwrap().len(), 2);
    assert_eq!(got["candidates"][0]["system"], "sub");
    assert_eq!(got["candidates"][1]["system"], "kube-ovn");
    for c in got["candidates"].as_array().unwrap() {
        assert_eq!(c["repo"], "https://github.com/kubeovn/kube-ovn");
        assert_eq!(c["repoGuessed"], true);
    }
    assert_eq!(got["candidates"][1]["version"], "v1.12.3");
}

#[test]
fn a_pair_pattern_never_reads_the_next_list_items_version() {
    let engine = Engine::new().unwrap();
    let doc = manifest::lines::Document::new(
        &engine,
        "- name: a\n  version: 1.0\n- name: b\n  version: 2.0\n",
    )
    .unwrap();
    let pattern = manifest::patterns::pair(&doc, 2, 3, "version").into();
    engine.check(&pattern).unwrap();
    assert_eq!(
        engine
            .read_ref(
                &pattern,
                &"- name: b\n  repository: r\n  version: 2.1\n".into()
            )
            .unwrap(),
        "2.1"
    );
    assert_eq!(
        engine
            .read_ref(&pattern, &"- name: b\n- name: c\n  version: 3.0\n".into())
            .unwrap_err()
            .to_string(),
        "versionMatch found no version in versionFrom"
    );
}
