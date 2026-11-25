//! The profile's `[mutants]` section (realm @nick/craft, node #645): whether the mutants of a
//! change run on this project and for how long. No command line: the review runs cargo-mutants on
//! its own diff and nothing a profile names. Read on its own, as a section the profile's format
//! keeps on every write, so a profile without it reads as before.

use std::path::Path;
use std::time::Duration;

use serde::Deserialize;

/// The section as the reviewer confirmed it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MutantsSection {
    /// The mutants do not run on this project.
    #[serde(default)]
    pub off: bool,
    /// How long they may run, in seconds; the review's default when absent.
    #[serde(default)]
    pub budget_secs: Option<u64>,
}

impl MutantsSection {
    /// The budget it names, else `default`; never zero.
    #[must_use]
    pub fn budget(&self, default: Duration) -> Duration {
        self.budget_secs
            .filter(|s| *s > 0)
            .map_or(default, Duration::from_secs)
    }
}

/// The `[mutants]` section of the profile at `path`: the default when the profile or the section
/// is absent.
///
/// # Errors
/// When the profile cannot be read, is not TOML, or the section is not of this shape.
pub fn of(path: &Path) -> Result<MutantsSection, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(MutantsSection::default()),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    let table: toml::Table =
        toml::from_str(&text).map_err(|e| format!("{}: {}", path.display(), e.message()))?;
    let Some(section) = table.get("mutants") else {
        return Ok(MutantsSection::default());
    };
    section
        .clone()
        .try_into()
        .map_err(|e: toml::de::Error| format!("{}: [mutants]: {}", path.display(), e.message()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEN: Duration = Duration::from_mins(10);

    /// The section of a profile holding `text`.
    fn read(text: &str) -> Result<MutantsSection, String> {
        let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
        let path = dir.path().join("review.toml");
        std::fs::write(&path, text).map_err(|e| e.to_string())?;
        of(&path)
    }

    #[test]
    fn a_profile_without_the_section_runs_them_for_the_default_budget() {
        let s = read("version = 1\n").unwrap();
        assert!(!s.off);
        assert_eq!(s.budget(TEN), TEN);
        assert_eq!(
            of(Path::new("/nonexistent/review.toml")).unwrap(),
            MutantsSection::default()
        );
    }

    #[test]
    fn the_section_turns_them_off_or_names_their_budget() {
        assert!(read("version = 1\n[mutants]\noff = true\n").unwrap().off);
        let s = read("version = 1\n[mutants]\nbudget_secs = 900\n").unwrap();
        assert_eq!(s.budget(TEN), Duration::from_mins(15));
        let zero = read("version = 1\n[mutants]\nbudget_secs = 0\n").unwrap();
        assert_eq!(zero.budget(TEN), TEN);
    }

    #[test]
    fn a_profile_that_cannot_be_read_is_an_error_not_the_defaults() {
        let dir = tempfile::tempdir().unwrap();
        of(dir.path()).unwrap_err();
    }

    #[test]
    fn a_command_line_in_the_section_is_refused_not_run() {
        let e = read("version = 1\n[mutants]\ncommand = \"rm -rf /\"\n").unwrap_err();
        assert!(e.contains("command"), "{e}");
    }
}
