use super::{Error, text};
use craft_store::js::JsString;
use std::path::{Component, Path, PathBuf};

pub(super) fn canonical(path: &Path) -> Result<PathBuf, std::io::Error> {
    std::fs::canonicalize(path).map(|p| normal(&p))
}

#[cfg(not(windows))]
fn normal(path: &Path) -> PathBuf {
    path.to_path_buf()
}

#[cfg(windows)]
fn normal(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{unc}"));
    }
    PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(&text))
}

fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => out.push(c),
        }
    }
    out
}

pub(super) fn read(root: &Path, rel: &JsString, max: u64, label: &str) -> Result<String, Error> {
    let absolute = lexical(&normal(&root.join(rel.to_utf8_lossy())));
    let outside = || Error::refused(format!("{label} resolves outside the repository"));
    if !absolute.starts_with(root) {
        return Err(outside());
    }
    let resolved = canonical(&absolute).map_err(|_io| {
        Error::refused(text::join(&[
            format!("{label} ").into(),
            rel.clone(),
            " not found".into(),
        ]))
    })?;
    if !resolved.starts_with(root) {
        return Err(outside());
    }
    let fault = |operation, source| Error::File {
        operation,
        path: resolved.clone(),
        source,
    };
    let stat = std::fs::metadata(&resolved).map_err(|e| fault("stat", e))?;
    if !stat.is_file() || stat.len() > max {
        return Err(Error::refused(text::join(&[
            format!("{label} ").into(),
            rel.clone(),
            format!(" is not a file of at most {max} bytes").into(),
        ])));
    }
    Ok(
        String::from_utf8_lossy(&std::fs::read(&resolved).map_err(|e| fault("read", e))?)
            .into_owned(),
    )
}
