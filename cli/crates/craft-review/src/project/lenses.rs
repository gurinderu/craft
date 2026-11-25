//! The profile's `[lenses]` section (realm @nick/craft, node #644): each lens of a profile named
//! `profile:lens` with its state — `always`, `first-round` or `off` — as the reviewer confirmed it.
//! What it may say is [`crate::composition::Composition::of`]'s to check.

use std::collections::BTreeMap;
use std::path::Path;

use super::section::SectionError;
use crate::composition::State;

/// The `[lenses]` section of the profile at `path`, each `profile:lens` with its state; empty when
/// the profile or the section is absent.
///
/// # Errors
/// When the profile cannot be read, is not TOML, or a state is none of the three.
pub fn of(path: &Path) -> Result<Vec<(String, State)>, SectionError> {
    let section: Option<BTreeMap<String, State>> = super::section::of(path, "lenses")?;
    Ok(section.unwrap_or_default().into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(text: &str) -> Result<Vec<(String, State)>, String> {
        let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
        let path = dir.path().join("review.toml");
        std::fs::write(&path, text).map_err(|e| e.to_string())?;
        of(&path).map_err(|e| e.to_string())
    }

    #[test]
    fn each_lens_is_read_with_its_state() {
        let got = read("version = 1\n[lenses]\n\"rust:money\" = \"off\"\n\"general:concurrency\" = \"first-round\"\n").unwrap();
        assert_eq!(
            got,
            [
                ("general:concurrency".to_owned(), State::FirstRound),
                ("rust:money".to_owned(), State::Off)
            ]
        );
        assert!(read("version = 1\n").unwrap().is_empty());
    }

    #[test]
    fn a_state_of_another_name_is_refused_with_its_section() {
        let e = read("version = 1\n[lenses]\n\"rust:money\" = \"sometimes\"\n").unwrap_err();
        assert!(e.contains("[lenses]"), "{e}");
    }
}
