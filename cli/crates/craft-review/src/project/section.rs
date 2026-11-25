//! One section of the reviewer's profile read on its own (`[mutants]`, `[lenses]`): a section the
//! profile's format keeps on every write, so a profile without it reads as before, and a binary
//! that does not know it leaves it be.

use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;

/// Why a section could not be read.
#[derive(Debug, thiserror::Error)]
pub enum SectionError {
    #[error("{}: {source}", path.display())]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("{}: [{section}]: {}", path.display(), source.message())]
    Toml {
        path: PathBuf,
        section: String,
        #[source]
        source: Box<toml::de::Error>,
    },
}

/// The section `name` of the profile at `path`; `None` when the profile or the section is absent.
///
/// # Errors
/// When the profile cannot be read, is not TOML, or the section is not of `T`'s shape.
pub fn of<T: DeserializeOwned>(path: &Path, name: &str) -> Result<Option<T>, SectionError> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(SectionError::Read {
                path: path.to_owned(),
                source,
            });
        }
    };
    let toml = |source: toml::de::Error| SectionError::Toml {
        path: path.to_owned(),
        section: name.to_owned(),
        source: Box::new(source),
    };
    let table: toml::Table = toml::from_str(&text).map_err(toml)?;
    table
        .get(name)
        .map(|s| s.clone().try_into().map_err(toml))
        .transpose()
}
