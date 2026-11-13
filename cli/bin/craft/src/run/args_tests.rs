use clap::Parser;

use super::*;

#[derive(Parser)]
struct Cli {
    #[command(flatten)]
    run: RunArgs,
}

fn host(argv: &[&str], vars: &[(&str, &str)]) -> Result<Host, String> {
    let cli = Cli::try_parse_from([&["craft"], argv].concat()).map_err(|e| e.to_string())?;
    let env = |what: &str| {
        vars.iter()
            .find(|(k, _)| *k == what)
            .map(|(_, v)| (*v).to_owned())
    };
    host_with(&cli.run, &env)
}

#[test]
fn pi_thinks_by_the_flag_then_its_variable_then_the_tier() {
    let tiered = host(&["--backend", "pi"], &[]).unwrap();
    assert_eq!(tiered.thinking["opus"], "high");
    let env = host(&["--backend", "pi"], &[("THINKING", "haiku=off")]).unwrap();
    assert_eq!(env.thinking["haiku"], "off");
    assert_eq!(env.thinking["sonnet"], "medium");
    let flag = host(
        &["--backend", "pi", "--thinking", "max"],
        &[("THINKING", "nonsense")],
    )
    .unwrap();
    assert!(flag.thinking.values().all(|l| l == "max"));
}

#[test]
fn a_bad_level_or_another_hosts_thinking_is_refused() {
    let why = host(&["--backend", "pi", "--thinking", "huge"], &[]).unwrap_err();
    assert!(why.contains("not a thinking level"), "{why}");
    assert!(why.starts_with("--thinking "), "the flag is named: {why}");
    let why = host(&["--backend", "pi"], &[("THINKING", "opus=huge")]).unwrap_err();
    assert!(
        why.starts_with("CRAFT_PI_THINKING "),
        "the env is named: {why}"
    );
    let why = host(&["--backend", "codex", "--thinking", "high"], &[]).unwrap_err();
    assert!(why.contains("pi's alone"), "{why}");
    let codex = host(&["--backend", "codex"], &[("THINKING", "huge")]).unwrap();
    assert!(codex.thinking.is_empty());
}
