//! Whether a CI map entry is one the gate can read (realm @nick/craft, node #482): its check one
//! line, its command one that runs its signal's cargo command, its files inside the repository and
//! each hashed. What its files hold is `ci_ground`'s.

use super::ci::CiEntry;
use super::ci_error::CiError;
use super::ci_files::relative;
use super::shell::signals_in;

impl CiEntry {
    /// Whether its check is one line and its command one that runs its signal's cargo command.
    pub(super) fn lines(&self) -> Result<(), CiError> {
        let at = &self.check;
        let line = |s: &str| !s.is_empty() && s.len() <= 300 && !s.contains(['\n', '\r']);
        if !line(at) {
            return Err(CiError::Check(at.clone()));
        }
        if !line(&self.command) || !signals_in(&self.command).contains(&self.signal) {
            return Err(CiError::Command {
                check: at.clone(),
                command: self.command.clone(),
                signal: self.signal.as_str(),
            });
        }
        Ok(())
    }

    /// Whether the entry is one the gate can read: its files inside the repository, each hashed.
    ///
    /// # Errors
    /// Why not, naming the check.
    pub fn check(&self) -> Result<(), CiError> {
        self.lines()?;
        let at = &self.check;
        self.hashes.keys().try_for_each(|p| relative(p))?;
        let hex = |h: &String| h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit());
        let files = std::iter::once(&self.workflow).chain(&self.sources);
        for f in files {
            relative(f)?;
            if !self.hashes.get(f).is_some_and(hex) {
                return Err(CiError::Hash {
                    check: at.clone(),
                    path: f.clone(),
                });
            }
        }
        match self.hashes.iter().find(|(_, h)| !hex(h)) {
            Some((p, _)) => Err(CiError::Hash {
                check: at.clone(),
                path: p.clone(),
            }),
            None => Ok(()),
        }
    }
}
