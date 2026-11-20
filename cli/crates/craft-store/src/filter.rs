//! Which runs a listing keeps: by project, branch, name, version, time and verdict. A row the store
//! holds without a field a filter asks for is not kept.

use crate::js::Obj;

/// The filters of `craft runs ls` and `stats`; each `None` keeps every run.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Filter {
    /// The repository key, or its last path component(s).
    pub project: Option<String>,
    pub branch: Option<String>,
    /// The workflow name (`review`, `triage-findings`, …).
    pub name: Option<String>,
    pub version: Option<String>,
    /// Runs at or after this stamp prefix (`2026-11-01`, `2026-11-01T10`).
    pub since: Option<String>,
    /// Runs before this stamp prefix.
    pub until: Option<String>,
    /// A piece of the verdict, case folded (`block`, `incomplete`).
    pub verdict: Option<String>,
}

/// A stamp the user typed as the store spells it: `:` as `-`.
fn as_stamp(t: &str) -> String {
    t.replace(':', "-")
}

impl Filter {
    /// Whether the run `r` — an index line or a detail record — is kept.
    #[must_use]
    pub fn keeps(&self, r: &Obj) -> bool {
        let project = |want: &String| {
            let have = r.text("project");
            have == want || have.ends_with(&format!("/{}", want.trim_start_matches('/')))
        };
        let ts = r.text("ts");
        let verdict = |want: &String| {
            r.text("verdict")
                .to_lowercase()
                .contains(&want.to_lowercase())
        };
        self.project.as_ref().is_none_or(project)
            && self.branch.as_ref().is_none_or(|b| r.text("branch") == b)
            && self.name.as_ref().is_none_or(|n| r.text("name") == n)
            && self
                .version
                .as_ref()
                .is_none_or(|v| r.text("craftVersion") == v)
            && self
                .since
                .as_ref()
                .is_none_or(|s| !ts.is_empty() && *ts >= *as_stamp(s))
            && self
                .until
                .as_ref()
                .is_none_or(|u| !ts.is_empty() && *ts < *as_stamp(u))
            && self.verdict.as_ref().is_none_or(verdict)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js::parse;

    fn row() -> Obj {
        let text = r#"{"ts":"2026-11-02T10-00-00Z","name":"review","project":"/h/p/craft","branch":"main","craftVersion":"0.54.1","verdict":"Block (INCOMPLETE)"}"#;
        parse(text).unwrap().as_obj().unwrap().clone()
    }

    #[test]
    fn every_filter_keeps_only_what_it_names() {
        let keeps = |f: Filter| f.keeps(&row());
        assert!(keeps(Filter::default()));
        assert!(keeps(Filter {
            project: Some("craft".into()),
            ..Filter::default()
        }));
        assert!(keeps(Filter {
            project: Some("p/craft".into()),
            ..Filter::default()
        }));
        assert!(!keeps(Filter {
            project: Some("raft".into()),
            ..Filter::default()
        }));
        assert!(!keeps(Filter {
            branch: Some("dev".into()),
            ..Filter::default()
        }));
        assert!(keeps(Filter {
            verdict: Some("incomplete".into()),
            ..Filter::default()
        }));
        assert!(keeps(Filter {
            since: Some("2026-11-02".into()),
            ..Filter::default()
        }));
        assert!(!keeps(Filter {
            since: Some("2026-11-02T11:00".into()),
            ..Filter::default()
        }));
        assert!(keeps(Filter {
            until: Some("2026-11-03".into()),
            ..Filter::default()
        }));
        assert!(!keeps(Filter {
            version: Some("0.55.0".into()),
            ..Filter::default()
        }));
        assert!(!keeps(Filter {
            name: Some("triage-findings".into()),
            ..Filter::default()
        }));
    }
}
