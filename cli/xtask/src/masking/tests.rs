use super::why;

#[test]
fn a_line_whose_failure_fails_its_recipe_passes() {
    for line in [
        "prettier --check .",
        "@prettier --check .",
        "cd cli && cargo xtask gate \"$@\"",
        "node integrations/shared/check-mutation-floor.mjs ${1:+--base \"$1\"}",
        "python3 x.py agent a/*.md && python3 x.py command b/*.md",
        "echo 'a || b; c | d & e' \"x || y\" a\\|b",
        "tool 2>&1 >/dev/null",
        "tool &>log",
        "tool # a comment || true",
        "echo ${#x}",
        "[ ! -f x ] && test a != b",
        "x --true",
        "",
    ] {
        assert_eq!(why(line), None, "{line}");
    }
}

#[test]
fn a_line_that_hides_its_failure_is_named() {
    for (line, reason) in [
        ("-prettier --check .", "`-` prefix"),
        ("@-prettier --check .", "`-` prefix"),
        ("-@prettier --check .", "`-` prefix"),
        ("tool || true", "`||` fallback"),
        ("tool || true # why", "`||` fallback"),
        ("tool || true;", "`||` fallback"),
        ("tool ||true", "`||` fallback"),
        ("tool || exit 0", "`||` fallback"),
        ("tool || echo failed", "`||` fallback"),
        ("tool || :", "`||` fallback"),
        ("tool | cat", "pipe"),
        ("tool |& tee log", "pipe"),
        ("tool ; true", "`;` sequence"),
        ("tool; other", "`;` sequence"),
        ("tool &", "background"),
        ("tool & wait", "background"),
        ("! tool", "`!`"),
        ("a && ! tool", "`!`"),
        ("echo \"x\" || true", "`||` fallback"),
        ("echo 'x' | cat", "pipe"),
        ("echo a#b || true", "`||` fallback"),
    ] {
        let got = why(line);
        assert!(got.is_some_and(|w| w.contains(reason)), "{line}: {got:?}");
    }
}
