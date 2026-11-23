use super::runs_command;

#[test]
fn an_outside_subcommand_counts_and_a_build_in_the_checkout_does_not() {
    for line in [
        "docker push registry.example.com/app:1",
        "docker login registry.example.com",
        "docker exec app sh",
        "podman push quay.io/app:1",
        "podman login quay.io",
        "podman exec app sh",
        "nix copy --to ssh://h ./result",
        "curl https://api.example.com/v1",
        "wget http://example.com/x",
    ] {
        assert!(runs_command(line), "{line}");
    }
    for line in [
        "docker build -t app .",
        "docker run --rm app",
        "podman build .",
        "nix build .#default",
        "curl --version",
        "wget --help",
    ] {
        assert!(!runs_command(line), "{line}");
    }
}

#[test]
fn words_split_at_shell_punctuation_and_redirections_without_spaces() {
    for line in [
        "cat m.yaml|kubectl apply -f -",
        "true&&kubectl get pods",
        "cd x;kubectl get pods",
        "(cd x)kubectl get pods",
        "echo `kubectl get pods`",
        "psql<<EOF",
        "mysql<dump.sql",
        "echo x>psql",
        "$kubectl get pods",
        "echo #kubectl",
    ] {
        assert!(runs_command(line), "{line}");
    }
    assert!(!runs_command("cat m.yaml|grep x&&ls;echo `date`"));
}
