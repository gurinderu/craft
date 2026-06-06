# Security tools: usage and config

All install via `cargo binstall <tool>` (prebuilt) or `cargo install <tool>`; in CI use
`taiki-e/install-action`. Each degrades gracefully — if a tool is absent, note it and continue.

## `cargo audit` — known vulnerabilities (RUSTSEC)

Checks `Cargo.lock` against the [RustSec Advisory Database](https://rustsec.org).

```bash
cargo audit                    # report advisories
cargo audit --deny warnings    # fail CI on any advisory (incl. unmaintained)
cargo audit fix                # attempt to bump to patched versions (experimental)
```

Advisories include vulnerabilities, unsound code, and unmaintained crates. A fixed version
present → upgrade; none → see triage in the skill entry.

## `cargo deny` — supply chain & policy

The broadest gate: advisories **plus** licenses, banned/duplicate crates, and allowed sources.
Configured by `deny.toml`:

```toml
[advisories]
# RUSTSEC db; fail on vulnerabilities. (advisory ignores go here, with a reason)
ignore = []

[licenses]
allow = ["MIT", "Apache-2.0", "BSD-3-Clause", "Unicode-3.0"]
# anything not allowed -> error

[bans]
multiple-versions = "warn"     # flag duplicate versions of the same crate
deny = [{ crate = "openssl", use-instead = "rustls", reason = "prefer rustls" }]

[sources]
unknown-registry = "deny"      # only crates.io / declared registries
```

```bash
cargo deny check               # all sections
cargo deny check licenses      # just one
```

`cargo deny` is the single most useful supply-chain gate — wire it into CI.

## `cargo geiger` — unsafe surface

Counts `unsafe` usage in your crate and its dependency tree, so you can see how much unaudited
unsafe you're pulling in.

```bash
cargo geiger                   # table of unsafe usage per dependency
```

High counts aren't automatic failure — they tell you which deps warrant a look at their safety
story (→ `rust-unsafe`). Note: `geiger` can lag toolchain changes; treat it as a signal.

## `semgrep` — patterns, taint, and custom rules

Rust is GA in semgrep (function-level dataflow/taint, 40+ Pro rules, supply-chain reachability).

```bash
semgrep --config=auto                 # community + relevant rulesets
semgrep --config="p/rust"             # the Rust ruleset
semgrep --config=p/secrets            # hardcoded secrets
semgrep --config=./semgrep/ --error   # your custom rules; non-zero exit on findings (CI)
```

### Custom rules — the real value

Encode rules the Rust-native tools can't. Example: forbid building SQL with `format!`:

```yaml
# semgrep/no-format-sql.yml
rules:
  - id: sql-from-format
    languages: [rust]
    severity: ERROR
    message: Build queries with bind parameters, not format!/string concatenation.
    patterns:
      - pattern: sqlx::query($Q)
      - metavariable-pattern:
          metavariable: $Q
          patterns:
            - pattern: format!(...)
```

Taint example (attacker input → dangerous sink): declare `pattern-sources` (e.g. request body
extractors) and `pattern-sinks` (e.g. `Command::new(...).arg(...)`, raw SQL) and let semgrep
flag flows between them. Keep custom rules in-repo so review and CI share them.

## Secrets

`cargo audit`/`deny` don't find secrets in *your* source. Use `semgrep --config=p/secrets` and/or
`gitleaks` to catch hardcoded keys/tokens (also a CRITICAL item in `rust-review`).

## CI shape

```bash
cargo deny check          # licenses + advisories + bans (fast, authoritative)
cargo audit --deny warnings
semgrep --config=p/rust --config=./semgrep/ --error
# cargo geiger            # informational; gate only if you track a budget
```
