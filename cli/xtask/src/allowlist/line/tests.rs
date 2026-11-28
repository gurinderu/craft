use super::check_line;

#[test]
fn the_forms_the_gate_uses_pass() {
    for (line, takes_params) in [
        ("prettier --check .", false),
        ("cd cli && cargo xtask gate \"$@\"", true),
        (
            "node integrations/shared/check-mutation-floor.mjs ${1:+--base \"$1\"}",
            true,
        ),
        (
            "python3 x.py agent a/*.md && python3 x.py command b/*.md",
            false,
        ),
        (
            "npx --yes @anthropic-ai/claude-code plugin validate . --strict",
            false,
        ),
        ("eslint --config a.mjs --max-warnings 0", false),
        ("tool 2>&1", false),
        ("tool >&2", false),
        ("tool >out.txt", false),
        ("tool > out.txt && other", false),
        ("tool 'a b|c; d' \"e f\" --x=\"y\" --n=1,2+3", false),
        ("tool \"$1\"", true),
        ("a&&b", false),
        ("tool>out.txt", false),
    ] {
        assert_eq!(check_line(line, takes_params), Ok(()), "{line}");
    }
}

#[test]
fn every_other_form_is_refused_naming_what_was_found() {
    for (line, found) in [
        // a failure fallen back from, piped, sequenced, backgrounded or inverted
        ("tool || true", "`|`"),
        ("tool | cat", "`|`"),
        ("tool; other", "`;`"),
        ("tool & wait", "`&`"),
        ("tool&", "`&`"),
        ("tool &", "`&`"),
        ("! tool", "`!`"),
        ("(! tool)", "`(`"),
        ("( ! tool )", "`(`"),
        ("!(tool)", "`!`"),
        ("{ tool; }", "`{`"),
        ("[[ a || b ]]", "`[`"),
        ("?[ -f x ]", "`?`"),
        // just's own prefixes and interpolation
        ("-tool", "prefix"),
        ("@tool", "prefix"),
        ("@-tool", "prefix"),
        ("tool {{mask}}", "`{{`"),
        ("tool '{{mask}}'", "`{{`"),
        // another shell, recipe or command substitution
        ("just other", "another shell or recipe"),
        ("sh -c 'tool || true'", "another shell or recipe"),
        ("bash -c tool", "another shell or recipe"),
        ("/bin/sh -c tool", "another shell or recipe"),
        ("a && env sh -c tool", "another shell or recipe"),
        ("eval tool", "another shell or recipe"),
        ("'sh' -c tool", "quoted or expanded command"),
        ("tool $(other)", "`$`"),
        ("tool \"$(other)\"", "`$` in"),
        ("tool `other`", "```"),
        ("tool \"`other`\"", "backquote"),
        ("tool $'x'", "`$`"),
        ("tool $HOME", "`$`"),
        ("tool ${x:-a|b}", "`$`"),
        // redirections beyond the three, comments, escapes
        ("tool <&0", "`<`"),
        ("tool >>log", "redirection other than"),
        ("tool >\"$f\"", "`$` in"),
        ("tool >'f'", "not a plain file name"),
        ("tool # why", "`#`"),
        ("tool a\\ b", "`\\`"),
        ("tool 'open", "unclosed"),
        ("tool && && other", "empty command"),
        ("tool &&", "empty command"),
        ("", "empty command"),
    ] {
        let got = check_line(line, false);
        assert!(
            got.as_ref().is_err_and(|w| w.contains(found)),
            "{line}: {got:?}"
        );
    }
}

#[test]
fn the_positional_forms_need_a_recipe_that_takes_a_parameter() {
    for line in [
        "cd cli && cargo xtask gate \"$@\"",
        "node x.mjs ${1:+--base \"$1\"}",
        "tool \"$1\"",
    ] {
        assert!(check_line(line, false).is_err(), "{line}");
        assert_eq!(check_line(line, true), Ok(()), "{line}");
    }
    assert!(check_line("tool \"$2\"", true).is_err());
}
