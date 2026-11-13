//! The host as it runs in the repository a run reviews when that is not the checkout `review run`
//! was started in — craft's own worktree of the PR given, or the checkout a resumed run recorded
//! (realm `@nick/craft`, node #517). opencode is asked again which agents it has there: its
//! project-scoped agents (`.opencode/`, as `install.sh` lays them by default) live in the user's
//! checkout and are not in craft's worktree, and a task on a missing `review-task` would run on
//! opencode's writable default agent.

use std::path::Path;

use super::HostKind;
use super::host::Host;
use super::opencode;

/// `host` as it runs in `repo`: opencode's agents listed there; another host as it is.
///
/// # Errors
/// Why opencode cannot run the review's tasks in `repo`, naming the worktree.
pub(crate) fn host_in(host: &Host, repo: &Path, log: &dyn Fn(&str)) -> Result<Host, String> {
    if host.kind != HostKind::OpenCode {
        return Ok(host.clone());
    }
    let ready = opencode::preflight(&host.command, repo, log).map_err(|why| {
        format!(
            "the review runs in {}, not in the checkout it was started from, and there {why}. Agents installed into a project (`.opencode/`, install.sh's default) are not in craft's own worktree of a pull request: install craft's OpenCode agents globally (`integrations/opencode/install.sh --global`) or, on OpenCode 2.x, add the craft package",
            repo.display()
        )
    })?;
    Ok(Host {
        agents: ready.agents,
        archived: ready.archived,
        ..host.clone()
    })
}

#[cfg(test)]
mod tests {
    use super::super::exe::write_executable;
    use super::super::models::{ModelTable, ThinkingTable};
    use super::*;

    /// A stand-in opencode 2.x whose `review-task` agent is there only in a directory holding a
    /// project `.opencode/`.
    fn project_scoped(dir: &Path) -> Host {
        let command = dir.join("opencode");
        let script = r#"#!/bin/sh
case "$1" in
  --version) echo 'opencode v2.2.7' ;;
  debug) if [ -d .opencode ]; then echo '[{"id":"build"},{"id":"review-task"}]'; else echo '[{"id":"build"}]'; fi ;;
  *) exit 9 ;;
esac
"#;
        write_executable(&command, script).unwrap();
        Host {
            kind: HostKind::OpenCode,
            models: ModelTable::default(),
            thinking: ThinkingTable::default(),
            command,
            agents: Some(vec!["build".into(), "review-task".into()]),
            archived: true,
        }
    }

    #[test]
    fn opencode_s_agents_are_listed_again_in_the_repository_the_run_reviews() {
        let dir = tempfile::tempdir().unwrap();
        let (checkout, worktree) = (dir.path().join("checkout"), dir.path().join("worktree"));
        std::fs::create_dir_all(checkout.join(".opencode")).unwrap();
        std::fs::create_dir_all(&worktree).unwrap();
        let host = project_scoped(dir.path());
        let there = host_in(&host, &checkout, &|_| {}).unwrap();
        assert_eq!(
            there.agents,
            Some(vec!["build".into(), "review-task".into()])
        );
        let why = host_in(&host, &worktree, &|_| {}).unwrap_err();
        for want in [
            worktree.display().to_string().as_str(),
            "review-task",
            "not in craft's own worktree",
            "install.sh --global",
        ] {
            assert!(why.contains(want), "{want} missing from: {why}");
        }
    }

    #[test]
    fn another_host_runs_there_as_it_is() {
        let host = Host {
            kind: HostKind::Pi,
            models: ModelTable::default(),
            thinking: ThinkingTable::default(),
            command: "/no/pi".into(),
            agents: None,
            archived: false,
        };
        let there = host_in(&host, Path::new("/nowhere"), &|_| {}).unwrap();
        assert_eq!(there.command, host.command);
    }
}
