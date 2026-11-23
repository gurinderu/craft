use super::{carries_steps, is_markdown, reader};

#[test]
fn a_shell_block_or_a_numbered_step_running_a_command_carries_steps() {
    for text in [
        "# Restore\n\n```sh\nkubectl -n kube-system delete pod ovn-central-0\n```\n",
        "```bash\n$ helm upgrade --install x ./chart\n```",
        "```console\n$ sudo systemctl restart kubelet\n```",
        "```\ngh pr merge 12 --squash\n```",
        "~~~zsh\nexport A=1\nterraform apply -auto-approve\n~~~",
        "Steps:\n\n1. Drain the node: `kubectl drain node-1 --ignore-daemonsets`\n2. Wait.\n",
        "3) Dump first: `pg_dump -Fc db > db.dump`",
    ] {
        assert!(carries_steps(text), "{text}");
    }
}

#[test]
fn prose_other_languages_and_checkout_commands_carry_none() {
    for text in [
        "# Project\n\nWe use kubectl in production.\n",
        "```rust\nfn main() { println!(\"kubectl\"); }\n```",
        "```sh\ncargo build --release\nnpm ci\n```",
        "```json\n{\"curl\": true}\n```",
        "1. Read the `README` first.\n2. Run `cargo test`.",
        "- `kubectl get pods` lists pods (a bullet, not a numbered step)",
        "```sh\ncargo test\n```\nkubectl outside any block",
    ] {
        assert!(!carries_steps(text), "{text}");
    }
}

#[test]
fn the_reader_reads_markdown_in_the_working_tree_only() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("RUNBOOK.md"),
        "```sh\nkubectl get pods\n```",
    )
    .unwrap();
    std::fs::write(dir.path().join("x.sh"), "kubectl get pods").unwrap();
    let steps = reader(dir.path());
    assert!(steps("RUNBOOK.md"));
    assert!(!steps("x.sh"), "not Markdown");
    assert!(!steps("gone.md"), "deleted: nothing to read");
    assert!(is_markdown("docs/Ops.MARKDOWN") && !is_markdown("a.mdx"));
}
