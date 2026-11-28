use std::collections::BTreeSet;

use craft_store::js::{Js, JsString, Obj};

use super::read::{Row, Run};
use super::{GROUPS_MAX, TITLES_MAX, number, text};

#[derive(Default)]
pub(super) struct Group<'a> {
    members: Vec<(&'a Run, &'a Row)>,
    file: JsString,
    titles: Vec<JsString>,
    branches: BTreeSet<JsString>,
    runs: BTreeSet<JsString>,
    severities: BTreeSet<JsString>,
    last_seen: JsString,
}

impl<'a> Group<'a> {
    /// The rows the group holds, by identity.
    pub fn rows(&self) -> impl Iterator<Item = *const Row> + '_ {
        self.members.iter().map(|(_, row)| std::ptr::from_ref(*row))
    }

    fn matches(&self, row: &Row) -> bool {
        text::within(&row.file, &self.file)
            && self
                .titles
                .iter()
                .any(|t| text::overlap(&row.title, t) >= 0.6)
    }

    fn add(&mut self, run: &'a Run, row: &'a Row) {
        self.members.push((run, row));
        if !self.titles.contains(&row.title) {
            self.titles.push(row.title.clone());
        }
        self.branches.insert(run.branch.clone());
        self.runs.insert(run.file.clone());
        if !row.severity.is_empty() {
            self.severities.insert(row.severity.clone());
        }
        if run.ts > self.last_seen {
            self.last_seen.clone_from(&run.ts);
        }
    }

    fn json(&self) -> Js {
        let mut severities: Vec<_> = self.severities.iter().collect();
        severities.sort_by(|a, b| severity_rank(a).cmp(&severity_rank(b)).then(a.cmp(b)));
        Js::Obj(
            Obj::new()
                .with("file", Js::str(&self.file))
                .with("titles", strings(self.titles.iter().take(TITLES_MAX)))
                .with(
                    "titlesMore",
                    number(self.titles.len().saturating_sub(TITLES_MAX)),
                )
                .with("branches", strings(&self.branches))
                .with("runs", strings(&self.runs))
                .with("lastSeen", Js::str(&self.last_seen))
                .with("severities", strings(severities)),
        )
    }
}

fn strings<'a>(items: impl IntoIterator<Item = &'a JsString>) -> Js {
    Js::Arr(items.into_iter().map(Js::str).collect())
}

fn severity_rank(s: &JsString) -> usize {
    ["Critical", "High", "Medium", "Low", "Info"]
        .iter()
        .position(|v| s == *v)
        .unwrap_or(5)
}

pub(super) fn recurring(runs: &[Run]) -> (Vec<Js>, usize) {
    listed(&grouped(
        runs.iter()
            .flat_map(|run| run.rows.iter().map(move |row| (run, row))),
    ))
}

/// The groups found on two branches or more, ranked; each row joins the first group it matches.
pub(super) fn grouped<'a>(rows: impl IntoIterator<Item = (&'a Run, &'a Row)>) -> Vec<Group<'a>> {
    let mut groups: Vec<Group<'a>> = vec![];
    for (run, row) in rows {
        if let Some(group) = groups.iter_mut().find(|g| g.matches(row)) {
            group.add(run, row);
        } else {
            let mut group = Group {
                file: row.file.clone(),
                ..Group::default()
            };
            group.add(run, row);
            groups.push(group);
        }
    }
    groups.retain(|g| g.branches.len() >= 2);
    // Deliberately locale-independent UTF-16 tie breaks (realm @nick/craft, #205).
    groups.sort_by(|a, b| {
        b.branches
            .len()
            .cmp(&a.branches.len())
            .then(b.last_seen.cmp(&a.last_seen))
            .then(a.file.cmp(&b.file))
    });
    groups
}

pub(super) fn listed(groups: &[Group<'_>]) -> (Vec<Js>, usize) {
    let cut = groups.len().saturating_sub(GROUPS_MAX);
    (
        groups.iter().take(GROUPS_MAX).map(Group::json).collect(),
        cut,
    )
}
