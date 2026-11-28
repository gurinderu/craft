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
        ("knip 2>&1", false),
        ("knip >&2", false),
        ("knip >out.txt", false),
        ("knip > out.txt && vitest", false),
        ("knip 'a b|c; d' \"e f\" --x=\"y\" --n=1,2+3", false),
        ("knip \"$1\"", true),
        ("knip&&vitest", false),
        ("knip>out.txt", false),
    ] {
        assert_eq!(check_line(line, takes_params), Ok(()), "{line}");
    }
}

#[test]
fn every_other_form_is_refused_naming_what_was_found() {
    for (line, found) in [
        // a failure fallen back from, piped, sequenced, backgrounded or inverted
        ("knip || true", "`|`"),
        ("knip | cat", "`|`"),
        ("knip; vitest", "`;`"),
        ("knip & wait", "`&`"),
        ("knip&", "`&`"),
        ("knip &", "`&`"),
        ("! knip", "`!`"),
        ("(! knip)", "`(`"),
        ("( ! knip )", "`(`"),
        ("!(knip)", "`!`"),
        ("{ knip; }", "`{`"),
        ("[[ a || b ]]", "`[`"),
        ("?[ -f x ]", "`?`"),
        // just's own prefixes and interpolation
        ("-knip", "prefix"),
        ("@knip", "prefix"),
        ("@-knip", "prefix"),
        ("knip {{mask}}", "`{{`"),
        ("knip '{{mask}}'", "`{{`"),
        // another shell, recipe or command substitution
        ("just vitest", "not one of the gate's commands"),
        ("sh -c 'knip || true'", "not one of the gate's commands"),
        ("bash -c knip", "not one of the gate's commands"),
        ("/bin/sh -c knip", "not one of the gate's commands"),
        ("knip && env sh -c knip", "not one of the gate's commands"),
        ("eval knip", "not one of the gate's commands"),
        ("'sh' -c knip", "quoted or expanded command"),
        ("knip $(vitest)", "`$`"),
        ("knip \"$(vitest)\"", "`$` in"),
        ("knip `vitest`", "```"),
        ("knip \"`vitest`\"", "backquote"),
        ("knip $'x'", "`$`"),
        ("knip $HOME", "`$`"),
        ("knip ${x:-a|b}", "`$`"),
        // redirections beyond the three, comments, escapes
        ("knip <&0", "`<`"),
        ("knip >>log", "redirection other than"),
        ("knip >\"$f\"", "`$` in"),
        ("knip >'f'", "not a plain file name"),
        ("knip # why", "`#`"),
        ("knip a\\ b", "`\\`"),
        ("knip 'open", "unclosed"),
        ("knip && && vitest", "empty command"),
        ("knip &&", "empty command"),
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
        "knip \"$1\"",
    ] {
        assert!(check_line(line, false).is_err(), "{line}");
        assert_eq!(check_line(line, true), Ok(()), "{line}");
    }
    assert!(check_line("knip \"$2\"", true).is_err());
}
