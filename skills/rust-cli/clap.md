# Argument parsing with clap

Use the **derive API** — declare a struct/enum and clap generates the parser, help, and
`--version`.

```toml
[dependencies]
clap = { version = "4", features = ["derive", "env"] }
anyhow = "1"
```

## Flags, options, positionals

```rust
use clap::Parser;
use std::path::PathBuf;

#[derive(Parser)]
#[command(version, about = "Process some files")]
struct Cli {
    /// Input file (positional)
    input: PathBuf,

    /// Output path (option with default)
    #[arg(short, long, default_value = "out.txt")]
    output: PathBuf,

    /// Verbosity (-v, -vv, -vvv)  →  repeated flag count
    #[arg(short, long, action = clap::ArgAction::Count)]
    verbose: u8,

    /// From flag OR the API_TOKEN env var
    #[arg(long, env = "API_TOKEN")]
    token: Option<String>,
}

let cli = Cli::parse();
```

The doc comment becomes the help text. `short`/`long` derive `-o`/`--output` from the field
name. `env = "..."` lets a flag fall back to an environment variable.

## Constrained values

```rust
use clap::ValueEnum;

#[derive(Clone, ValueEnum)]
enum Format { Json, Yaml, Toml }

#[derive(Parser)]
struct Cli {
    #[arg(long, value_enum, default_value_t = Format::Json)]
    format: Format,                 // --format json|yaml|toml, validated by clap
}
```

clap rejects invalid values with a helpful error before your code runs — push validation into
types (`ValueEnum`, `PathBuf`, numeric parsing) rather than re-checking strings.

## Subcommands

Model `git`-style commands as an enum:

```rust
#[derive(Parser)]
#[command(version, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(clap::Subcommand)]
enum Command {
    /// Add an item
    Add { name: String },
    /// Remove by id
    Remove { #[arg(short, long)] id: u64 },
    /// Launch the interactive UI
    Ui,
}

fn run(cli: Cli) -> anyhow::Result<()> {
    match cli.command {
        Command::Add { name }   => add(&name),
        Command::Remove { id }  => remove(id),
        Command::Ui             => crate::tui::run(),   // hand off to ratatui (tui.md)
    }
}
```

## Help, version, completions

- `#[command(version, about, long_about = None)]` wires `--version` / `--help` from `Cargo.toml`
  metadata.
- Shell completions: the `clap_complete` crate generates bash/zsh/fish/powershell scripts.
- Man pages: `clap_mangen`.

## Errors and exit codes

Let clap handle *usage* errors (it prints help and exits with code 2 automatically). Your
`run` returns `Result`; `main` maps an `Err` to a non-zero exit and prints to stderr (→ the CLI
anatomy in the skill entry, and `rust-errors`). Don't `panic!` for user mistakes — that's a
defect path, not a usage error.
