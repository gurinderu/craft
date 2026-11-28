//! The day the session start last offered a retro, per repository (realm @nick/craft, node #658):
//! `~/.craft/retro-offered.json`, `{ "<repo key>": <days since 1970> }`. A file that does not read
//! is no day; it is replaced whole through a file beside it, so a concurrent start never reads half
//! of it. A write that fails offers again at the next start: an offer too many, never one lost.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

fn file(home: &Path) -> PathBuf {
    home.join(".craft").join("retro-offered.json")
}

fn days(home: &Path) -> BTreeMap<String, i64> {
    std::fs::read_to_string(file(home))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// Whether the repository filed under `key` was offered a retro on day `today`.
pub fn already(home: &Path, key: &str, today: i64) -> bool {
    days(home).get(key) == Some(&today)
}

/// Marks `key` offered on `today`, the entries `keep` days old or more dropped.
pub fn mark(home: &Path, key: &str, today: i64, keep: i64) {
    let mut seen = days(home);
    seen.retain(|_, day| today - *day < keep);
    seen.insert(key.to_owned(), today);
    let Ok(text) = serde_json::to_string(&seen) else {
        return;
    };
    let to = file(home);
    let beside = to.with_extension(format!("json.{}", std::process::id()));
    if std::fs::write(&beside, text).is_ok() && std::fs::rename(&beside, &to).is_err() {
        drop(std::fs::remove_file(&beside));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_day_marked_is_read_back_old_days_are_dropped_and_a_broken_file_is_none() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join(".craft")).unwrap();
        assert!(!already(home.path(), "/a", 100));
        mark(home.path(), "/a", 100, 14);
        mark(home.path(), "/b", 105, 14);
        assert!(already(home.path(), "/a", 100) && !already(home.path(), "/a", 101));
        mark(home.path(), "/c", 114, 14);
        let kept: Vec<String> = days(home.path()).into_keys().collect();
        assert_eq!(
            kept,
            ["/b", "/c"],
            "/a, 14 days old, is dropped; /b, 9, is kept"
        );
        std::fs::write(file(home.path()), "{not json").unwrap();
        assert!(!already(home.path(), "/b", 105));
        mark(home.path(), "/b", 106, 14);
        assert!(already(home.path(), "/b", 106));
        assert_eq!(
            std::fs::read_dir(home.path().join(".craft"))
                .unwrap()
                .count(),
            1,
            "no file left beside it"
        );
    }
}
