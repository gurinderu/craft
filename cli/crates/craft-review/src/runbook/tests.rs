use super::{carries_steps, step_lines};

fn sh(body: &str) -> String {
    format!("```sh\n{body}\n```\n")
}

#[test]
fn a_command_against_an_external_system_is_a_step_wherever_it_sits_on_its_line() {
    for line in [
        "kubectl -n kube-system delete pod ovn-central-0",
        "$ helm upgrade --install x ./chart",
        "KUBECONFIG=/x kubectl delete pod p",
        "PGPASSWORD=secret psql -h db -c 'select 1'",
        "sudo -u postgres psql",
        "sudo systemctl restart kubelet",
        "cat m.yaml | kubectl apply -f -",
        "cd infra && terraform apply -auto-approve",
        "for n in a b; do kubectl drain $n; done",
        "X=$(kubectl get pods -o name)",
        "watch -n 5 kubectl get pods",
        "/usr/local/bin/gh pr merge 12",
        "curl -X DELETE https://api.example.com/v1/things/1",
        "git push --force origin main",
        "docker push registry.example.com/app:1",
        "nix copy --to ssh://host ./result",
        "user@bastion:~$ ssh node-1",
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
        "echo kubectl",
        "# kubectl delete pod p  (a comment)",
    ] {
        assert!(!carries_steps(&sh(line)), "{line}");
    }
}

#[test]
fn a_continued_command_is_one_step_over_all_its_lines() {
    let text = "intro\n```bash\n# drain first\nkubectl drain node-1 \\\n  --ignore-daemonsets\nnpm ci\n```\n";
    assert_eq!(step_lines(text), [4, 5]);
}

#[test]
fn a_numbered_step_counts_by_its_inline_code() {
    assert_eq!(
        step_lines("Steps:\n\n1. Drain: `kubectl drain node-1`\n2. Wait.\n3) `pg_dump -Fc db`\n"),
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
    assert_eq!(step_lines(inner), [3]);
    // A ~~~ block closes only on ~~~, at least as long.
    let tilde = "~~~~zsh\n```\nterraform apply\n~~~\nhelm list\n~~~~\n";
    assert_eq!(step_lines(tilde), [3, 5]);
    // A one-line ```code``` opens nothing, so the real block after it is read as shell.
    let inline =
        "```kubectl get pods``` lists them.\n\n```sh\nkubectl delete pod p\n```\nkubectl prose\n";
    assert_eq!(step_lines(inline), [4]);
    // A non-shell block's lines are no steps; nor is code indented four spaces into a fence.
    assert!(!carries_steps("```rust\nkubectl();\n```"));
    assert!(!carries_steps("    ```sh\n    kubectl get pods\n    ```"));
}
