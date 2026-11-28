use super::super::base::Options;
use super::super::{Status, base, options};
use super::recorder;

#[test]
fn the_base_is_the_one_given_else_origin_main_when_it_resolves_else_none() {
    let mut never = recorder(|_, _| Status::Exit(0));
    assert_eq!(
        base(Some("abc".to_owned()), &mut never).as_deref(),
        Some("abc")
    );
    assert!(never.quiet.is_empty());
    let mut found = recorder(|_, _| Status::Exit(0));
    assert_eq!(base(None, &mut found).as_deref(), Some("origin/main"));
    assert_eq!(
        found.quiet,
        ["git rev-parse --verify --quiet origin/main^{commit}"]
    );
    let mut missing = recorder(|cmd, _| {
        if cmd == "git" {
            Status::Exit(1)
        } else {
            Status::Exit(0)
        }
    });
    assert_eq!(base(None, &mut missing), None);
}

#[test]
fn reads_base_and_refuses_anything_else() {
    let args = |a: &[&str]| a.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
    assert_eq!(options(&args(&[])), Ok(Options { base: None }));
    assert_eq!(
        options(&args(&["--base", "abc"])),
        Ok(Options {
            base: Some("abc".to_owned())
        })
    );
    assert_eq!(
        options(&args(&["--base"])),
        Err("--base needs a ref".to_owned())
    );
    for empty in ["", " "] {
        assert_eq!(
            options(&args(&["--base", empty])),
            Err("--base needs a ref".to_owned()),
            "{empty:?}"
        );
    }
    assert!(
        options(&args(&["--bse", "x"]))
            .unwrap_err()
            .starts_with("unknown argument --bse")
    );
}
