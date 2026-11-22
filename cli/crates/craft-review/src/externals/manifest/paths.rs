#[derive(Clone, Copy)]
pub(in super::super) enum Kind {
    Chart,
    Values,
    Kustomization,
    Compose,
    Terraform,
    K8s,
}

fn yaml(name: &str) -> Option<&str> {
    name.strip_suffix(".yaml")
        .or_else(|| name.strip_suffix(".yml"))
}

fn suffix(s: &str) -> bool {
    s.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

pub(in super::super) fn kind(file: &str) -> Option<Kind> {
    let name = file.rsplit('/').next().unwrap_or("");
    if name == "Chart.yaml" {
        return Some(Kind::Chart);
    }
    let stem = yaml(name);
    if stem
        .and_then(|s| s.strip_prefix("values"))
        .is_some_and(suffix)
    {
        return Some(Kind::Values);
    }
    if name == "Kustomization" || stem == Some("kustomization") {
        return Some(Kind::Kustomization);
    }
    if stem
        .and_then(|s| {
            s.strip_prefix("docker-")
                .unwrap_or(s)
                .strip_prefix("compose")
        })
        .is_some_and(suffix)
    {
        return Some(Kind::Compose);
    }
    if name.ends_with(".tf") {
        return Some(Kind::Terraform);
    }
    if stem.is_none() || name.to_ascii_lowercase().contains("lock") {
        return None;
    }
    (!file
        .split('/')
        .any(|s| s.starts_with('.') || s == "templates"))
    .then_some(Kind::K8s)
}
