use super::{carries_steps, step_lines};

fn lines(text: &str) -> Vec<u32> {
    step_lines(text).into_iter().collect()
}

fn sh(body: &str) -> String {
    format!("```sh\n{body}\n```\n")
}

#[test]
fn a_known_command_anywhere_on_a_shell_line_is_a_step() {
    for line in [
        "kubectl -n kube-system delete pod ovn-central-0",
        "$ helm upgrade --install x ./chart",
        "KUBECONFIG=/x kubectl delete pod p",
        "cat m.yaml | kubectl apply -f -",
        "cd infra && terraform apply -auto-approve",
        "for n in a b; do kubectl drain $n; done",
        "X=$(kubectl get pods -o name)",
        "/usr/local/bin/gh pr merge 12",
        "curl -X DELETE https://api.example.com/v1/things/1",
        "user@bastion:~$ ssh node-1",
        "deploy .#host",
        // The forms option tables kept missing: clusters, quoted programs, unlisted values.
        "sudo -iu postgres psql",
        "watch 'kubectl get pods'",
        "sh -c 'systemctl restart x'",
        "bash -c \"kubectl delete pod p\"",
        "xargs --max-lines 1 kubectl delete pod",
        "env FOO='a b c' kubectl get pods",
        "docker --context prod exec app sh",
        "podman --url ssh://h/run/podman.sock exec app sh",
        "nix --substituters https://x copy --to ssh://h ./r",
        "nix --extra-experimental-features 'nix-command flakes' copy --to ssh://h ./r",
    ] {
        assert!(carries_steps(&sh(line)), "{line}");
    }
}

#[test]
fn a_command_that_runs_in_the_checkout_is_no_step() {
    for line in [
        "cargo build --release",
        "npm ci",
        "nix build .#default",
        "nix develop",
        "docker build -t app .",
        "curl --version",
        "git commit -m x",
        "git push --force origin main",
        "docker --context prod build .",
        "podman --connection prod build .",
        "nix --option a b build .#x",
        "# kubectl delete pod p  (a comment)",
    ] {
        assert!(!carries_steps(&sh(line)), "{line}");
    }
}

#[test]
fn a_continued_command_is_one_step_over_all_its_lines() {
    let text = "intro\n```bash\n# drain first\nkubectl drain node-1 \\\n  --ignore-daemonsets\nnpm ci\n```\n";
    assert_eq!(step_lines(text).into_iter().collect::<Vec<_>>(), [2, 4, 5]);
}

#[test]
fn a_numbered_step_counts_by_its_inline_code() {
    assert_eq!(
        lines("Steps:\n\n1. Drain: `kubectl drain node-1`\n2. Wait.\n3) `pg_dump -Fc db`\n"),
        [3, 5]
    );
    for text in [
        "1. Read the `README` first.\n2. Run `cargo test`.",
        "- `kubectl get pods` lists pods (a bullet, not a numbered step)",
        "# Project\n\nWe use kubectl in production.\n",
    ] {
        assert!(!carries_steps(text), "{text}");
    }
}

#[test]
fn fences_open_and_close_by_commonmark_s_rule() {
    // A four-backtick block holding a ``` line stays open past it: its kubectl is not shell.
    let four = "````markdown\n```sh\nkubectl get pods\n```\n````\n";
    assert!(!carries_steps(four), "{four}");
    // A closing fence carries no info string: ```python does not close a sh block.
    let inner = "```sh\n```python\nkubectl get pods\n```\n";
    assert_eq!(lines(inner), [1, 3]);
    // A ~~~ block closes only on ~~~, at least as long.
    let tilde = "~~~~zsh\n```\nterraform apply\n~~~\nhelm list\n~~~~\n";
    assert_eq!(lines(tilde), [1, 3, 5]);
    // A one-line ```code``` opens nothing, so the real block after it is read as shell.
    let inline =
        "```kubectl get pods``` lists them.\n\n```sh\nkubectl delete pod p\n```\nkubectl prose\n";
    assert_eq!(lines(inline), [3, 4]);
    // A non-shell block's lines are no steps; nor is a top-level indented code block.
    assert!(!carries_steps("```rust\nkubectl();\n```"));
    assert!(!carries_steps("    ```sh\n    kubectl get pods\n    ```"));
    // A shorter closer, or one indented four spaces, closes nothing: the block runs on.
    assert_eq!(
        lines("````sh\nkubectl get pods\n```\nhelm list\n````\n"),
        [1, 2, 4]
    );
    assert_eq!(
        lines("```sh\nkubectl get pods\n    ```\nhelm list\n```\n"),
        [1, 2, 4]
    );
    // A command a `\` leaves open at the block's end is still a step.
    assert_eq!(lines("```sh\nkubectl drain n1 \\\n```\n"), [1, 2]);
}

#[test]
fn a_fence_nested_in_a_list_item_is_a_shell_block() {
    let numbered = "1. Drain the node:\n\n    ```sh\n    kubectl drain n1\n    ```\n2. Wait.\n";
    assert_eq!(lines(numbered), [3, 4]);
    let bullet = "- Upgrade:\n\n    ```bash\n    helm upgrade x ./chart\n    ```\n";
    assert_eq!(lines(bullet), [3, 4]);
}

#[test]
fn a_hash_is_a_root_prompt_only_in_a_session_block() {
    assert!(carries_steps(
        "```console\n# systemctl restart kubelet\n```"
    ));
    assert!(carries_steps(
        "```shell-session\n# systemctl restart kubelet\n```"
    ));
    assert!(!carries_steps("```sh\n# systemctl restart kubelet\n```"));
}

#[test]
fn a_here_document_s_body_is_part_of_the_command_that_opened_it() {
    let psql = "```sh\npsql \"$DB\" <<EOF\nDELETE FROM users;\nEOF\nnpm ci\n```\n";
    assert_eq!(lines(psql), [1, 2, 3, 4]);
    let manifest = "```sh\nkubectl apply -f - <<'EOF'\nspec:\n  replicas: 0\nEOF\n```\n";
    assert_eq!(lines(manifest), [1, 2, 3, 4, 5]);
    // A body that ends with the block is still the command's.
    assert_eq!(lines("```sh\npsql <<SQL\ndrop table t;\n```\n"), [1, 2, 3]);
    // The body of a command acting on nothing outside is no step; the next command is read anew.
    let local = "```sh\ncat <<EOF > x.yaml\nreplicas: 0\nEOF\nkubectl apply -f x.yaml\n```\n";
    assert_eq!(lines(local), [1, 5]);
}

#[test]
fn a_quoted_argument_spanning_lines_is_part_of_its_command() {
    let ssh = "```sh\nssh db-1 '\n  set -e\n  systemctl stop app\n'\necho done\n```\n";
    assert_eq!(lines(ssh), [1, 2, 3, 4, 5]);
    let sql = "```sh\npsql -c \"\nDELETE FROM users;\n\"\n```\n";
    assert_eq!(lines(sql), [1, 2, 3, 4]);
}

#[test]
fn an_indented_delimiter_closes_only_a_dashed_here_document() {
    // Under a plain `<<`, an indented EOF is body: the command runs on to the real one.
    let plain = "```sh\ncat <<EOF > x\n  EOF\nkubectl delete pod p\nEOF\n```\n";
    assert_eq!(lines(plain), [1, 2, 3, 4, 5]);
    let dashed = "```sh\ncat <<-EOF > x\n\tEOF\nkubectl delete pod p\n```\n";
    assert_eq!(lines(dashed), [1, 4]);
}
