use std::path::{Path, PathBuf};

use super::{PrCreate, pr_create};

fn found(command: &str) -> Option<PrCreate> {
    pr_create(command, Path::new("/repo"), Some(Path::new("/home/u")))
}

fn dir(command: &str) -> Option<PathBuf> {
    found(command).map(|p| p.dir.unwrap())
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
fn gh_s_alias_and_a_repo_flag_before_pr_are_matched() {
    assert_eq!(dir("gh pr new --fill"), Some("/repo".into()));
    assert_eq!(dir("gh -R o/r pr create"), Some("/repo".into()));
    assert_eq!(dir("gh --repo o/r pr new"), Some("/repo".into()));
    assert_eq!(dir("gh --repo=o/r pr create"), Some("/repo".into()));
}

#[test]
fn rtk_env_and_assignments_before_gh_are_passed_over() {
    assert_eq!(dir("rtk gh pr create -f"), Some("/repo".into()));
    assert_eq!(dir("GH_TOKEN=t gh pr create"), Some("/repo".into()));
    assert_eq!(dir("env A=1 B=2 rtk gh pr create"), Some("/repo".into()));
    assert_eq!(dir("env -u X gh pr create"), Some("/repo".into()));
    assert_eq!(dir("env -i -- gh pr create"), Some("/repo".into()));
}

#[test]
fn shell_keywords_and_grouping_before_gh_are_passed_over() {
    for c in [
        "if true; then gh pr create; fi",
        "if false; then :; else gh pr create; fi",
        "for a in b; do gh pr create; done",
        "{ gh pr create; }",
        "! gh pr create",
        "time gh pr create",
        "time -p gh pr create",
        "command gh pr create",
        "sudo gh pr create",
        "sudo -u me gh pr create",
    ] {
        assert_eq!(dir(c), Some("/repo".into()), "{c:?}");
    }
}

#[test]
fn a_cd_chain_moves_the_directory_the_pr_is_opened_from() {
    assert_eq!(dir("cd sub && gh pr create"), Some("/repo/sub".into()));
    assert_eq!(dir("cd /w/x && cd y; gh pr create"), Some("/w/x/y".into()));
    assert_eq!(dir("cd ~/p && rtk gh pr create"), Some("/home/u/p".into()));
    assert_eq!(dir("cd \"a b\" && gh pr create"), Some("/repo/a b".into()));
    assert_eq!(dir("cd && gh pr create"), Some("/home/u".into()));
    assert_eq!(dir("cd -P sub && gh pr create"), Some("/repo/sub".into()));
    assert_eq!(dir("cd -- sub && gh pr create"), Some("/repo/sub".into()));
    assert_eq!(
        dir("cd -L -- sub && gh pr create"),
        Some("/repo/sub".into())
    );
    assert_eq!(dir("pushd sub && gh pr create"), Some("/repo/sub".into()));
}

#[test]
fn a_cd_out_of_a_subshell_does_not_move_the_pr() {
    assert_eq!(
        dir("(cd sub && git push) && gh pr create"),
        Some("/repo".into())
    );
    assert_eq!(dir("(cd sub && gh pr create)"), Some("/repo/sub".into()));
    assert_eq!(
        dir("cd a && (cd b) && gh pr create"),
        Some("/repo/a".into())
    );
}

#[test]
fn a_directory_the_hook_cannot_tell_is_said_why() {
    for (c, why) in [
        ("cd - && gh pr create", "`cd -`"),
        ("cd $WT && gh pr create", "`cd $WT`"),
        (
            "cd $(git rev-parse --show-toplevel) && gh pr create",
            "`cd $(git rev-parse --show-toplevel)`",
        ),
        ("popd && gh pr create", "`popd`"),
    ] {
        let err = found(c).unwrap().dir.unwrap_err();
        assert!(err.contains(why), "{c:?}: {err}");
    }
    assert_eq!(dir("cd $X && cd /abs && gh pr create"), Some("/abs".into()));
}

#[test]
fn a_later_segment_of_a_chain_is_matched() {
    assert_eq!(
        dir("git push -u origin HEAD && gh pr create --fill"),
        Some("/repo".into())
    );
    assert_eq!(dir("true\ngh pr create"), Some("/repo".into()));
    assert_eq!(
        dir("git push && \\\n  gh pr create --fill"),
        Some("/repo".into()),
        "a backslash-newline continues the line"
    );
    assert_eq!(dir("gh pr \\\ncreate"), Some("/repo".into()));
}

#[test]
fn a_heredoc_body_is_text_and_the_command_after_it_counts() {
    assert_eq!(dir("cat > n.md <<'EOF'\ngh pr create\nEOF"), None);
    assert_eq!(dir("cat <<EOF\ngh pr create\nEOF"), None);
    assert_eq!(dir("cat <<-\"X\"\n\tgh pr create\n\tX\necho"), None);
    assert_eq!(
        dir("cat <<-X\n\tgh pr create\n\tX\ngh pr create"),
        Some("/repo".into()),
        "<<- strips the tabs before its delimiter"
    );
    assert_eq!(
        dir("cat <<EOF > n\ngh pr create\nEOF\ngh pr create"),
        Some("/repo".into())
    );
    assert_eq!(dir("cat <<<'x'\ngh pr create"), Some("/repo".into()));
}

#[test]
fn the_head_branch_is_read_off_its_flag() {
    let head = |c: &str| found(c).unwrap().head;
    assert_eq!(head("gh pr create --fill"), None);
    assert_eq!(head("gh pr create --head feat/x"), Some("feat/x".into()));
    assert_eq!(head("gh pr create --head=feat/x"), Some("feat/x".into()));
    assert_eq!(head("gh pr create -H me:feat/x"), Some("feat/x".into()));
    assert_eq!(head("gh pr create -Hfeat/x"), Some("feat/x".into()));
}

#[test]
fn a_git_command_that_moves_head_first_is_named() {
    let moved = |c: &str| found(c).unwrap().moved_by;
    assert_eq!(moved("git push && gh pr create"), None);
    assert_eq!(moved("git status; git log && gh pr create"), None);
    for (c, sub) in [
        ("git commit -am x && gh pr create", "git commit"),
        ("git -C . checkout b && gh pr create", "git checkout"),
        ("rtk git -c a=b switch b && gh pr create", "git switch"),
        ("git reset --hard x; gh pr create", "git reset"),
        ("git pull && git push && gh pr create", "git pull"),
        ("git rebase main && gh pr create", "git rebase"),
        ("git merge x && gh pr create", "git merge"),
        ("git cherry-pick x && gh pr create", "git cherry-pick"),
        ("git am p && gh pr create", "git am"),
        ("git revert x && gh pr create", "git revert"),
        ("git stash && gh pr create", "git stash"),
    ] {
        assert_eq!(moved(c), Some(sub.into()), "{c:?}");
    }
    assert_eq!(moved("gh pr create && git commit"), None, "after it");
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
        "git push # later: gh pr create",
        "true # ; gh pr create",
        "true\n  # gh pr create",
        "gh pr create --help",
        "gh pr create -h",
        "gh pr new -h",
        "if gh pr view; then echo; fi",
        "",
    ] {
        assert_eq!(found(c), None, "{c:?}");
    }
}
