//! What is deliberately not a gate step, keyed as [`crate::keys`] keys a command, with the reason.

pub const EXCLUDED: &[(&str, &str)] = &[
    ("recipe:gate", "the gate itself"),
    (
        "script:gate",
        "the gate's npm alias, `just gate`, kept for one release so existing callers keep working",
    ),
    (
        "script:test:mutation",
        "Stryker rewrites integrations/shared/ in place for many minutes; the weekly mutation workflow runs it, and its floor is the check-mutation-floor step",
    ),
    (
        "script:build:engines",
        "regenerates integrations/claude-code/workflows/ from integrations/claude-code/src/ — a fix, not a check; check-engines holds its result",
    ),
    (
        "script:prepare",
        "wires .githooks/pre-commit into a git checkout on npm ci — setup, not a check",
    ),
    (
        "script:format",
        "rewrites files with prettier — a fix, not a check; check-format holds its result",
    ),
    (
        "script:check:dup:baseline",
        "regenerates .jscpd-baseline.json — a fix, not a check; check-dup holds its result",
    ),
    (
        "cmd:npm audit",
        "needs the network and is not reproducible (realm @nick/craft, #141): its own steps in CI's test job",
    ),
    (
        "file:integrations/shared/audit-count.mjs",
        "summarizes the network-only development-dependency audit in CI",
    ),
    (
        "cmd:semgrep",
        "its own CI job in a pinned image, rules fetched from the registry per run (realm @nick/craft, #138)",
    ),
    (
        "cmd:cargo",
        "the Rust CLI's fmt, clippy and tests are CI's rust job; the gate's own cargo xtask commands are keyed apart, as xtask:<name>",
    ),
    (
        "file:integrations/shared/quality-delta.mjs",
        "a signal between two checkouts, never a gate: CI's quality-delta job",
    ),
    (
        "cmd:npm ci",
        "installs, not a check: the gate needs both installs before it runs",
    ),
];
