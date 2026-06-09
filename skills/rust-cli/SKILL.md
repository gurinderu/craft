---
name: rust-cli
description: Building command-line and terminal apps in Rust — argument parsing with clap, subcommands, config, output/exit-code conventions, and full-screen TUIs with ratatui. Use when building a CLI tool, parsing args/subcommands, designing command output, or writing an interactive terminal UI. Triggers: clap, subcommand, exit code, TUI, ratatui, crossterm, indicatif.
---

# Rust CLI & TUI

Terminal programs come in two shapes with different models — pick the right one first. Both put
real logic in a library and keep the entrypoint thin (→ `rust-architecture`, `rust-ecosystem`).

## When to Use

- Building a command-line tool (args, subcommands, config, output)
- Designing exit codes and stdout/stderr behavior
- Writing an interactive full-screen terminal UI

## Decision: CLI or TUI?

| You're building | Model | Crate | Where |
|---|---|---|---|
| A tool: parse args → do work → print → exit | one-shot, non-interactive | **clap** | [clap.md](clap.md) |
| A full-screen interactive app (dashboard, editor) | render loop + events + state | **ratatui** | [tui.md](tui.md) |

Most "CLIs" are the first kind — don't reach for a TUI unless the app is genuinely interactive
and stateful. They can coexist (a clap subcommand that launches a TUI).

## CLI anatomy

```rust
use anyhow::Result;
use clap::Parser;

#[derive(Parser)]
#[command(version, about)]
struct Cli { /* args — see clap.md */ }

fn main() -> std::process::ExitCode {
    if let Err(e) = run(Cli::parse()) {
        eprintln!("error: {e:#}");          // errors to stderr, with the full chain
        return std::process::ExitCode::FAILURE;
    }
    std::process::ExitCode::SUCCESS
}

fn run(cli: Cli) -> Result<()> { /* the actual work, returns Result */ }
```

`main` parses and maps the result to an exit code; `run` holds the logic and returns `Result`
(→ `rust-errors` CLI pattern). Keep `run` thin too — call into a library.

## Output conventions

A well-behaved CLI is a good Unix citizen:

- **stdout = data, stderr = diagnostics.** Machine-readable results go to stdout so they pipe;
  logs, progress, and errors go to stderr.
- **Exit codes**: `0` success, non-zero failure. Use distinct codes if scripts need to branch.
- **Respect the pipe**: disable color/progress when stdout isn't a TTY (clap's color does this;
  `std::io::IsTerminal` / the `anstream` crate help). Don't emit ANSI into a file.
- **`--quiet` / `--verbose`** to control chatter; offer `--json` for scriptable output where it
  makes sense.
- Progress for long work: the `indicatif` crate (`indicatif = "0.18"`) — to **stderr**.

## Config layering

Precedence, highest first: **CLI flags → environment → config file → defaults.** clap reads
flags and env (`#[arg(env = "...")]`); for file + merge, layer with `figment` (or the `config`
crate) and let flags win. Validate the merged config once at startup — a bad config should fail
fast, not mid-run (→ `rust-errors`: startup precondition is a defect).

[`figment`](https://crates.io/crates/figment) merges typed config from layered providers, last
wins:

```toml
[dependencies]
figment = { version = "0.10", features = ["toml", "env"] }
serde = { version = "1", features = ["derive"] }
```

```rust
use figment::{Figment, providers::{Format, Toml, Env, Serialized}};

#[derive(Default, serde::Deserialize, serde::Serialize)]
struct Config { port: u16, log_level: String }

let config: Config = Figment::new()
    .merge(Serialized::defaults(Config::default()))  // defaults
    .merge(Toml::file("app.toml"))                    // file overrides defaults
    .merge(Env::prefixed("APP_"))                     // env overrides file (APP_PORT=...)
    .extract()?;                                      // typed + validated in one step
```

Layer CLI flags on top last (highest precedence) by merging parsed clap values. The same
`figment` setup serves long-running services too (→ `rust-cloud-native` config). Load secrets
into a `secrecy::SecretString` rather than a plain field (→ `rust-security`).

## Boundaries

- Argument parsing, subcommands, derive API → [clap.md](clap.md).
- Interactive full-screen UIs (render loop, widgets, events) → [tui.md](tui.md).
- Error reporting style (`anyhow` at the top, `eprintln!`, exit) → `rust-errors`.
- Logic-in-lib, thin binary → `rust-ecosystem` (project layout), `rust-architecture`.
