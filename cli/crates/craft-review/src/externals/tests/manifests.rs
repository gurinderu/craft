use super::{discover, put};
use serde_json::json;

#[test]
fn named_parsers_and_generated_patterns_preserve_versions_and_priority() {
    let root = tempfile::tempdir().unwrap();
    put(
        root.path(),
        "charts/values.yaml",
        "image:\n  repository: ghcr.io/kubeovn/kube-ovn\n  tag: v1.12.3\nagain:\n  image: ghcr.io/kubeovn/kube-ovn:v1.12.4\n",
    );
    let got = discover(root.path(), Some(&["charts/values.yaml"]), json!([]));
    assert_eq!(
        got["candidates"],
        json!([{
            "system":"kube-ovn","repo":"https://github.com/kubeovn/kube-ovn","repoGuessed":true,
            "versionFrom":"charts/values.yaml","scope":"charts","version":"v1.12.4",
            "versionMatch":r#"^[ \t]*(?:-[ \t]+)?image: ghcr\.io/kubeovn/kube-ovn:([^"'\s#@]+)"#,
            "note":"repo guessed from the image ghcr.io/kubeovn/kube-ovn"
        }])
    );
    put(
        root.path(),
        "Chart.yaml",
        "name: app\nversion: 0.1\nappVersion: v3\nsources:\n  - https://github.com/acme/app\ndependencies:\n  - name: db\n    version: v1\n  - name: ranged\n    version: \">=1.0\"\n",
    );
    put(
        root.path(),
        "kustomization.yaml",
        "notImages:\n- name: nginx\n  newName: ghcr.io/acme/nginx-fork\n  newTag: v1.25.3\n- name: busybox\n- name: redis\n  newTag: \"7.2\"\n",
    );
    put(
        root.path(),
        "main.tf",
        "source = \"git::https://github.com/o/vpc.git//modules/sub?ref=v5.1.0\"\nsource = \"git::ssh://git@github.com/o/thing.git?depth=1&ref=1.0.0\"\n",
    );
    put(
        root.path(),
        "pod.yaml",
        "apiVersion: v1\n---\nkind: Pod\nimage: busybox:1.36\n",
    );
    let got = discover(
        root.path(),
        Some(&["Chart.yaml", "kustomization.yaml", "main.tf", "pod.yaml"]),
        json!([]),
    );
    let systems: Vec<_> = got["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["system"].as_str().unwrap())
        .collect();
    assert_eq!(
        systems,
        [
            "app",
            "db",
            "nginx-fork",
            "redis",
            "vpc",
            "thing",
            "busybox"
        ]
    );
    assert_eq!(got["candidates"][4]["repo"], "https://github.com/o/vpc.git");
    assert_eq!(got["candidates"][5]["repo"], "");
}

#[test]
fn inline_scalar_and_filename_boundaries() {
    let root = tempfile::tempdir().unwrap();
    let text = "image: reg:5000/a/b:v1@sha256:abc\nimage: no-tag\nimage: reg:5000/a/c\nimage: a/d:latest\nimage: \"{{ .Values.x }}\"\nimage: '${TAG}'\nimage: '*alias'\nimage: '\u{feff}v'\n";
    put(root.path(), ".hidden/values.yaml", text);
    put(root.path(), "templates/values.yaml", text);
    put(
        root.path(),
        "templates/deploy.yaml",
        "apiVersion: v1\nkind: Pod\nimage: x/y:v1\n",
    );
    put(root.path(), "not-a-manifest.txt", text);
    put(
        root.path(),
        "Chart.yaml",
        "name: own\nappVersion: v1\nsources: []\n",
    );
    let got = discover(
        root.path(),
        Some(&[
            ".hidden/values.yaml",
            "templates/values.yaml",
            "templates/deploy.yaml",
            "not-a-manifest.txt",
            "Chart.yaml",
        ]),
        json!([]),
    );
    assert_eq!(got["candidates"].as_array().unwrap().len(), 2);
    assert_eq!(got["candidates"][0]["system"], "b");
    assert_eq!(got["candidates"][0]["version"], "v1");
}

#[test]
fn pairs_reject_duplicate_anchor_readback_and_keep_exact_bounded_pattern() {
    let root = tempfile::tempdir().unwrap();
    put(
        root.path(),
        "values.yaml",
        "a:\n  repository: x/y\n  tag: v1\nb:\n  repository: x/y\n  tag: v2\n",
    );
    let got = discover(root.path(), None, json!([]));
    assert_eq!(got["candidates"].as_array().unwrap().len(), 1);
    assert_eq!(got["candidates"][0]["version"], "v1");
    assert_eq!(
        got["candidates"][0]["versionMatch"],
        r#"^[ \t]*(?:-[ \t]+)?repository: x/y[ \t\r]*\n(?:(?:[ \t]{2}[^\n]*|[ \t]*(?:#[^\n]*)?\r?)\n){0,8}?^  tag:[ \t]*["']?([^"'\s#@]+)"#
    );
}
