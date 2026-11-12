---
name: nix-dev-env
description: >-
  Nix dev shells — mkShell, devShells.default, direnv with use flake, writeShellApplication for lint-checked scripts, formatters (alejandra, nixpkgs-fmt), linters (statix, deadnix), and pre-commit-hooks.nix. Use when building or debugging a dev environment in a flake, wiring direnv, or setting up Nix quality gates. Triggers: devShell, mkShell, direnv, .envrc, writeShellApplication, alejandra, statix, deadnix, pre-commit.
---

# Nix Dev Environments

A reproducible dev shell is a `pkgs.mkShell` derivation exposed as `devShells.default` in
your flake. Everyone who enters the shell gets identical tools, at the exact same versions,
without global installs.

## When to Use

- Defining or debugging a `devShells.default` in a flake
- Wiring `direnv` so the shell activates on `cd`
- Writing helper scripts that should be lint-checked (`writeShellApplication`)
- Adding Nix formatters or linters as a quality gate
- Hooking `statix`/`deadnix`/formatters into `pre-commit` via `pre-commit-hooks.nix`

## `pkgs.mkShell` — the shell derivation

`mkShell` is a thin wrapper around `stdenv.mkDerivation` that is only ever built for the
shell, never installed. The two fields you reach for most:

```nix
pkgs.mkShell {
  packages = [
    pkgs.rustup
    pkgs.cargo-nextest
    pkgs.alejandra      # Nix formatter
    pkgs.statix         # Nix linter
    pkgs.deadnix        # dead-code linter
  ];

  shellHook = ''
    echo "rust $(rustc --version 2>/dev/null || echo 'not yet installed')"
    export RUST_BACKTRACE=1
  '';
}
```

- `packages` (preferred over the legacy `buildInputs`) — tools placed on `PATH`.
- `shellHook` — bash snippet that runs each time the shell is entered; good for
  environment variable exports and one-time setup messages.
- Prefer `packages` over `buildInputs`/`nativeBuildInputs` in a pure dev-shell context;
  the distinction only matters inside actual derivation builds.

## Exposing as `devShells.default`

Wire the shell as a flake output so `nix develop` and direnv can find it:

```nix
# flake.nix (flake-parts style — see nix-flakes for the full flake skeleton)
perSystem = { pkgs, ... }: {
  devShells.default = pkgs.mkShell {
    packages = [ pkgs.cargo pkgs.rustfmt pkgs.clippy pkgs.alejandra pkgs.statix ];
    shellHook = ''
      export CARGO_TERM_COLOR=always
    '';
  };
};
```

`nix develop` with no arguments enters `devShells.default` for the current system.
Named shells (`devShells.ci`, `devShells.docs`) follow the same pattern and are entered
with `nix develop .#ci`.

## `direnv` — automatic shell entry on `cd`

`direnv` reads `.envrc` when you enter a directory and activates the shell without a
manual `nix develop`. Add `.envrc` to the project root:

```bash
# .envrc
use flake
```

Then allow it once:

```bash
direnv allow
```

After this, entering the directory loads `devShells.default` automatically; leaving
unloads it. Commit `.envrc`; add `.direnv/` to `.gitignore`.

`use flake` requires `nix-direnv` (a faster, cached loader). Install via your system
nix configuration or home-manager:

```nix
# home-manager fragment
programs.direnv = {
  enable = true;
  nix-direnv.enable = true;
};
```

Without `nix-direnv`, direnv falls back to a slow eval on every entry. With it,
the shell is rebuilt only when `flake.lock` or the relevant output changes.

## `writeShellApplication` — lint-checked scripts

`pkgs.writeShellApplication` is the correct primitive for shell scripts that live in
the flake. Unlike `writeScriptBin`, it runs the script through `shellcheck` at build
time and enforces `set -euo pipefail` — lint errors become build failures.

```nix
perSystem = { pkgs, ... }:
let
  check = pkgs.writeShellApplication {
    name = "check";
    runtimeInputs = [ pkgs.statix pkgs.deadnix pkgs.alejandra ];
    text = ''
      statix check .
      deadnix --fail .
      alejandra --check .
    '';
  };
in {
  devShells.default = pkgs.mkShell {
    packages = [ check pkgs.cargo pkgs.rustfmt pkgs.clippy ];
  };
  # also expose as a runnable app
  apps.check = { type = "app"; program = "${check}/bin/check"; };
};
```

Key points:
- `runtimeInputs` — tools available inside the script; they don't leak onto `PATH`
  outside it.
- `text` — the script body without a shebang; `writeShellApplication` adds
  `#!/usr/bin/env bash` and `set -euo pipefail` automatically.
- Prefer `writeShellApplication` over `writeScriptBin` whenever the script is more
  than one line — shellcheck catches quoting bugs before they reach CI.

## Nix formatters and linters — the quality gate

Two formatters cover `.nix` files:

| Tool | Style | Command |
|------|-------|---------|
| `alejandra` | opinionated, no config | `alejandra .` |
| `nixpkgs-fmt` | community standard | `nixpkgs-fmt .` |

Pick one per project and stick with it. `alejandra` is the current default in new
projects; `nixpkgs-fmt` is what nixpkgs itself uses.

Two linters catch correctness and dead-code issues:

| Tool | What it finds | Command |
|------|---------------|---------|
| `statix` | anti-patterns, redundant `rec`, deprecated syntax | `statix check .` |
| `deadnix` | unused `let` bindings and function arguments | `deadnix --fail .` |

Run both in CI as a gate — they are fast and have zero false positives on well-written
Nix. The CI integration and review workflow for these tools belongs to `nix-review`.

## `pre-commit-hooks.nix` — hooks wired from the flake

`pre-commit-hooks.nix` generates a `pre-commit` configuration as a Nix derivation,
keeping hook versions pinned with the rest of the flake.

```nix
# flake inputs
inputs = {
  nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  pre-commit-hooks.url = "github:cachix/pre-commit-hooks.nix";
  pre-commit-hooks.inputs.nixpkgs.follows = "nixpkgs";
};
```

```nix
# perSystem block
perSystem = { pkgs, system, ... }:
let
  hooks = inputs.pre-commit-hooks.lib.${system}.run {
    src = ./.;
    hooks = {
      alejandra.enable = true;
      statix.enable = true;
      deadnix.enable = true;
      rustfmt.enable = true;
    };
  };
in {
  devShells.default = pkgs.mkShell {
    packages = [ pkgs.cargo pkgs.rustfmt pkgs.clippy ];
    inherit (hooks) shellHook;   # installs hooks on shell entry
  };

  checks.pre-commit = hooks;     # also runs in `nix flake check`
};
```

`inherit (hooks) shellHook` installs the hooks when the developer enters the shell —
no separate `pre-commit install` step required. Adding the result to `checks` means
`nix flake check` validates the hook configuration without running the hooks.

## Gotcha: `allowUnfree` does not apply to `nix develop`

If your shell includes an unfree package (e.g. `pkgs.vscode`, `pkgs.cuda`), `nix develop`
will refuse with "unfree package … refused" even if your system config sets
`nixpkgs.config.allowUnfree = true`. The system config is not visible to flake evaluation.

**Fix — import nixpkgs with config explicitly:**

```nix
perSystem = { system, ... }:
let
  pkgs = import inputs.nixpkgs {
    inherit system;
    config.allowUnfree = true;
  };
in {
  devShells.default = pkgs.mkShell {
    packages = [ pkgs.vscode pkgs.cargo ];
  };
};
```

**Alternative — environment variable (no flake change needed):**

```bash
NIXPKGS_ALLOW_UNFREE=1 nix develop --impure
```

`--impure` is required when the flake evaluation reads environment variables. This is
handy for one-off overrides; prefer the explicit import for a permanent fix checked
into the flake.

Root cause: `nixpkgs.legacyPackages` (the default nixpkgs surface in `flake-parts` and
`flake-utils`) does not inherit `config` from NixOS module options.

## Boundaries

- Flake structure, `inputs`/`outputs` schema, `flake.lock`, `flake-parts`/`flake-utils`
  wiring, and exposing `devShells` as flake outputs → `nix-flakes`.
- Derivations, overlays, overrides, `callPackage`, and packaging Rust binaries for
  distribution → `nix-packaging`.
- Running `statix check` / `deadnix` in CI pipelines and using them as review gates →
  `nix-review`.
