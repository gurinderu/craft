use super::super::manifest;
use craft_store::js::JsString;
use std::path::Path;

#[derive(Default)]
struct Walk {
    files: Vec<JsString>,
    seen: usize,
    cut: bool,
}

impl Walk {
    fn visit(&mut self, root: &Path, rel: &str) {
        let Ok(entries) = std::fs::read_dir(root.join(rel)) else {
            return;
        };
        let Ok(mut entries) = entries.collect::<Result<Vec<_>, _>>() else {
            return;
        };
        // The accepted locale-independent order (realm @nick/craft, #435, #571).
        entries.sort_by_cached_key(|e| JsString::from(e.file_name().to_string_lossy().as_ref()));
        for entry in entries {
            self.seen += 1;
            if self.seen > 100_000 {
                self.cut = true;
                return;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let p = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir()
                && !name.starts_with('.')
                && !["node_modules", "vendor", "target"].contains(&name.as_str())
            {
                self.visit(root, &p);
            } else if kind.is_file() && manifest::kind(&p).is_some() {
                self.files.push(p.into());
            }
        }
    }
}

pub(super) fn manifests(root: &Path) -> (Vec<JsString>, bool) {
    let mut walk = Walk::default();
    walk.visit(root, "");
    (walk.files, walk.cut)
}
