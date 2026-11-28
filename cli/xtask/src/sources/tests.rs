use super::{agents_commands, check_files, ci_test_runs, scripts};

const CI: &str = "jobs:
  test:
    steps:
      - name: one
        run: npm ci
      - name: block
        run: |
          if [ -n \"$X\" ]; then
            just gate --base \"$X\"

          fi
      - name: folded
        run: >-
          semgrep scan
          --config x
      - name: keyed
        run: |
          npm test
        if: always()
      - uses: actions/checkout@v4
      - run: npm run first
      - run: |
          npm run second
        name: after
  rust:
    steps:
      - name: other job
        run: cargo test
";

#[test]
fn reads_each_run_of_the_test_job_only_a_block_scalar_joined() {
    let runs = ci_test_runs(CI).unwrap();
    assert_eq!(
        runs,
        [
            "npm ci".to_owned(),
            "          if [ -n \"$X\" ]; then\n            just gate --base \"$X\"\n\n          fi"
                .to_owned(),
            "          semgrep scan\n          --config x".to_owned(),
            "          npm test".to_owned(),
            "npm run first".to_owned(),
            "          npm run second".to_owned(),
        ]
    );
}

#[test]
fn a_ci_without_a_test_job_is_an_error() {
    assert_eq!(
        ci_test_runs("jobs:\n  rust:\n    steps: []\n"),
        Err("ci.yml has no `test` job".to_owned())
    );
}

#[test]
fn reads_the_command_cell_of_each_commands_row() {
    let md = "# x\n## Commands\nintro\n\n| What | Command |\n|---|---|\n| Unit tests | `just test` |\n| Two | `a` and `b` |\n\n## Next\n| Not | `this` |\n";
    assert_eq!(agents_commands(md), [" `just test` ", " `a` and `b` "]);
    assert!(agents_commands("no section").is_empty());
}

#[test]
fn lists_the_checkers_without_their_tests() {
    let names = [
        "check-a.mjs",
        "check-a.test.mjs",
        "gate.mjs",
        "check-b.mjs",
        "check-c.js",
    ]
    .map(str::to_owned);
    assert_eq!(
        check_files(names.into_iter()),
        [
            "integrations/shared/check-a.mjs",
            "integrations/shared/check-b.mjs"
        ]
    );
}

#[test]
fn reads_the_package_scripts() {
    let s = scripts(r#"{"scripts": {"test": "vitest run", "n": 1}}"#).unwrap();
    assert_eq!(
        s.into_iter().collect::<Vec<_>>(),
        [("test".to_owned(), "vitest run".to_owned())]
    );
    assert_eq!(
        scripts(r#"{"name": "x"}"#),
        Err("package.json has no scripts".to_owned())
    );
    assert!(
        scripts("not json")
            .unwrap_err()
            .starts_with("package.json: ")
    );
}
