---
name: rust-security
description: >-
  Rust security review — auditing dependencies for known vulnerabilities (cargo-audit/RUSTSEC), licenses and supply chain (cargo-deny), unsafe surface (cargo-geiger), and code-level patterns/taint/custom rules (semgrep). Use when security-reviewing a Rust project, vetting dependencies, checking for vulnerable crates or license issues, or setting up a security gate. Triggers: CVE, RUSTSEC, cargo-audit, cargo-deny, cargo-geiger, semgrep, SAST, supply chain, taint.
---

# Rust Security

The security pass over a Rust project: vet what you depend on, measure your unsafe surface, and
scan code for dangerous patterns. The `rust-security-scanner` agent runs this and reports; this
skill is the rubric. Tool usage and config are in [tools.md](tools.md).

## When to Use

- Security review of a Rust project or PR
- Vetting dependencies (vulnerabilities, licenses, supply chain)
- Setting up a security gate in CI
- Auditing the `unsafe` footprint

## Threat areas and tools

| Area | What goes wrong | Tool |
|---|---|---|
| **Vulnerable deps** | a dependency has a known CVE/RUSTSEC advisory | `cargo audit` |
| **Supply chain & policy** | bad license, yanked/duplicate/banned crate, untrusted source | `cargo deny` |
| **Unsafe surface** | how much `unsafe` you and your deps pull in | `cargo geiger` |
| **Code patterns / taint** | injection, hardcoded secrets, banned APIs, tainted input → sink | `semgrep` (+ clippy) |
| **App-level (in the diff)** | SQL/command injection, path traversal, unbounded deserialization, secrets in source | `rust-review` (CRITICAL — Safety) |

These are complementary: `cargo audit`/`deny` look at *what you depend on*, `geiger` at *unsafe
exposure*, `semgrep`/clippy at *your code*. Run all of them.

## Severity & verdict

Same shape as `rust-review`:

| Verdict | When |
|---|---|
| **Block** ⛔ | a vulnerable dep with a known exploit/fix available; a real injection/secret/taint finding; a denied license |
| **Warning** ⚠️ | advisories with no fix yet (mitigate/track), unmaintained-crate warnings, high unsafe surface |
| **Approve** ✅ | clean audit/deny, no high-confidence code findings |

Report each finding as `severity · source(tool) · what · why exploitable · fix/mitigation`.

## Triage — signal vs noise

- **RUSTSEC advisory with a fixed version** → bump it; that's the easy win.
- **Advisory with no fix** → assess reachability (do you call the affected path?), pin/patch, or
  replace the crate; if truly unreachable, document an allow with an expiry, don't ignore silently.
- **Unmaintained crate** (RUSTSEC-…-unmaintained) → warning, plan a migration; not an emergency.
- **semgrep finding** → confirm the source is actually attacker-controlled and reaches the sink
  before calling it real (taint can over-report); adversarially verify like any review finding.
- **`unsafe` in a dependency** → `geiger` counts it; high counts warrant reading the crate's
  safety story, not automatic rejection.

## Custom rules are the point of semgrep

clippy/audit catch the known; **semgrep encodes *your* rules** — banned APIs, "never log this
type", "don't build SQL with format!", taint from request body to a command. That's its edge
over the Rust-native tools (which it complements, not replaces). Examples in [tools.md](tools.md).

## Handling secrets in memory

Scanning for *hardcoded* secrets (above) is only half the job — secrets that legitimately live in
memory (API keys, tokens, passwords loaded from env) must not **leak** via `Debug`/logs, linger
in memory, or land in core dumps/swap. Wrap them in [`secrecy`](https://crates.io/crates/secrecy):

```toml
[dependencies]
secrecy = "0.10"
```

```rust
use secrecy::{SecretString, ExposeSecret};

struct Config { api_key: SecretString }     // Debug is redacted (no secret bytes printed)

let key = SecretString::from(std::env::var("API_KEY")?);
client.authenticate(key.expose_secret());   // .expose_secret() is the only way out — greppable
```

- `SecretBox<T>` / `SecretString` give a **redacted `Debug`** (a secret can't accidentally end up
  in a log line or error) and **zeroize the memory on drop** (via `zeroize`, so it doesn't linger).
- `expose_secret()` is the single, searchable point where the raw value is accessed — easy to
  audit and to lint.
- Load secrets straight into a `SecretString` at the config boundary (→ `rust-cloud-native` /
  `rust-cli` config); never put a raw `String` secret on a struct that derives `Debug`/`Serialize`.

`zeroize` (`zeroize = "1"`) is the lower-level primitive if you need to scrub a buffer (keys,
decrypted plaintext) without the `secrecy` wrapper.

## Boundaries

- Reviewing the *diff's* code for correctness + safety smells → `rust-review` (this skill is the
  tooling/supply-chain layer; they share the verdict vocabulary).
- *Soundness* of your own `unsafe` (invariants, UB) → `rust-unsafe`; verify it with the
  `rust-miri` agent.
- Dependency *freshness/unused* (not security) → `rust-ecosystem`.
- *Fuzzing* parsers / deserializers / any untrusted-input surface for panics and crashes
  (`cargo-fuzz`) → `rust-testing`.
