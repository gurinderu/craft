use std::path::{Path, PathBuf};

use super::pr_create_dir;

fn dir(command: &str) -> Option<PathBuf> {
    pr_create_dir(command, Path::new("/repo"), Some(Path::new("/home/u")))
}

#[test]
fn a_plain_pr_create_runs_in_the_hook_cwd() {
    assert_eq!(dir("gh pr create"), Some("/repo".into()));
    assert_eq!(
        dir("gh pr create --title 'x' --body \"y; z\""),
        Some("/repo".into())
    );
    assert_eq!(dir("  gh   pr   create  "), Some("/repo".into()));
}

#[test]
fn rtk_env_and_assignments_before_gh_are_passed_over() {
    assert_eq!(dir("rtk gh pr create -f"), Some("/repo".into()));
    assert_eq!(dir("GH_TOKEN=t gh pr create"), Some("/repo".into()));
    assert_eq!(dir("env A=1 B=2 rtk gh pr create"), Some("/repo".into()));
}

#[test]
fn a_cd_chain_moves_the_directory_the_pr_is_opened_from() {
    assert_eq!(dir("cd sub && gh pr create"), Some("/repo/sub".into()));
    assert_eq!(dir("cd /w/x && cd y; gh pr create"), Some("/w/x/y".into()));
    assert_eq!(dir("cd ~/p && rtk gh pr create"), Some("/home/u/p".into()));
    assert_eq!(dir("cd \"a b\" && gh pr create"), Some("/repo/a b".into()));
    assert_eq!(dir("cd && gh pr create"), Some("/home/u".into()));
}

#[test]
fn a_later_segment_of_a_chain_is_matched() {
    assert_eq!(
        dir("git push -u origin HEAD && gh pr create --fill"),
        Some("/repo".into())
    );
    assert_eq!(dir("true\ngh pr create"), Some("/repo".into()));
    assert_eq!(dir("(cd sub && gh pr create)"), Some("/repo/sub".into()));
}

#[test]
fn other_commands_are_not_matched() {
    for c in [
        "gh pr view 3",
        "gh pr list | grep create",
        "gh pr createx",
        "ghx pr create",
        "gh issue create",
        "echo gh pr create",
        "git commit -m 'gh pr create'",
        "echo \"x; gh pr create\"",
        "echo 'a && gh pr create'",
        r"echo a\;gh pr create",
        "gh pr create --help",
        "gh pr create -h",
        "",
    ] {
        assert_eq!(dir(c), None, "{c:?}");
    }
}
