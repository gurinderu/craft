---
name: nix-flakes
description: >-
  Nix flakes — flake.nix inputs/outputs schema, pinning with flake.lock, the standard outputs (devShells, packages, nixosConfigurations, homeConfigurations), and flake-parts / flake-utils. Use when writing or debugging a flake, pinning or updating inputs, or exposing dev shells or packages. Triggers: flake.nix, flake.lock, nix flake, inputs, outputs, flake-parts, follows.
---

# Nix Flakes

A flake is a directory with a `flake.nix` that declares its inputs (other flakes) and
outputs (packages, shells, system configs, …). The `flake.lock` pins every input to an
exact revision — reproducibility lives in that lock file.

## The `{ inputs, outputs }` schema

```nix
{
  description = "My project";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    # dedupe: make rust-overlay use the same nixpkgs as the root
    rust-overlay.url = "github:oxalica/rust-overlay";
    rust-overlay.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = inputs @ { self, nixpkgs, flake-parts, ... }:
    # outputs is a function of the inputs attrset
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "x86_64-linux" "aarch64-darwin" ];
      perSystem = { pkgs, ... }: {
        packages.default = pkgs.hello;
        devShells.default = pkgs.mkShell { buildInputs = [ pkgs.hello ]; };
      };
    };
}
```

Key rules:
- `inputs.<name>.url` is the only required field per input.
- `outputs` is a **function** — it receives the resolved inputs.
- `self` refers to the flake itself (useful for `self.packages`, `self.nixosConfigurations`).

## `inputs.<x>.follows` — deduplicating nixpkgs

Without `follows`, each input that depends on nixpkgs pulls its own copy, inflating the
closure and risking subtle version skews. Fix it explicitly:

```nix
inputs = {
  nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  home-manager.url = "github:nix-community/home-manager";
  home-manager.inputs.nixpkgs.follows = "nixpkgs";   # ← one nixpkgs
};
```

`follows` makes the dependency graph a DAG rather than a tree — all consumers share the
same store path.

## `flake.lock` — the pin, not a hand-edit

`flake.lock` records exact `rev`, `narHash`, and `lastModified` for every input. It is
machine-managed:

| Command | Effect |
|---------|--------|
| `nix flake update` | Update all inputs to their latest revisions |
| `nix flake update nixpkgs` | Update one specific input |
| `nix flake lock --update-input nixpkgs` | Older equivalent, still works |
| `nix flake metadata` | Show the resolved lock without touching it |
| `nix flake show` | List all outputs without building |
| `nix flake check` | Evaluate + build a smoke-check of all outputs |

**Never hand-edit `flake.lock`.** It is a cryptographic manifest; a wrong `narHash`
breaks evaluation immediately.

Commit `flake.lock` to version control — it is the reproducibility guarantee.

## Standard output attributes

Outputs are an attrset; Nix tooling recognises these conventional keys:

| Output | Type | CLI |
|--------|------|-----|
| `packages.<system>.default` | derivation | `nix build` |
| `packages.<system>.<name>` | derivation | `nix build .#<name>` |
| `devShells.<system>.default` | mkShell | `nix develop` |
| `devShells.<system>.<name>` | mkShell | `nix develop .#<name>` |
| `nixosConfigurations.<host>` | NixOS system | `nixos-rebuild switch --flake .#<host>` |
| `homeConfigurations.<user>` | HM config | `home-manager switch --flake .#<user>` |
| `apps.<system>.<name>` | `{ type="app"; program=…; }` | `nix run .#<name>` |
| `checks.<system>.<name>` | derivation | `nix flake check` |

All per-system keys use the Nix system string (`x86_64-linux`, `aarch64-darwin`, etc.).

## `flake-utils` vs `flake-parts` for multi-system outputs

### `flake-utils` (simple, function-based)

```nix
outputs = { self, nixpkgs, flake-utils }:
  flake-utils.lib.eachDefaultSystem (system:
    let pkgs = nixpkgs.legacyPackages.${system};
    in {
      packages.default = pkgs.hello;
      devShells.default = pkgs.mkShell { buildInputs = [ pkgs.hello ]; };
    }
  );
```

`eachDefaultSystem` iterates over the four default platforms and merges the results.
Simple but scales poorly when some outputs are system-agnostic (`nixosConfigurations`,
`overlays`) — those must be added outside the `eachDefaultSystem` call.

### `flake-parts` (module-based, composable)

```nix
outputs = inputs @ { flake-parts, ... }:
  flake-parts.lib.mkFlake { inherit inputs; } {
    systems = [ "x86_64-linux" "aarch64-darwin" ];
    perSystem = { pkgs, config, ... }: {
      packages.default = pkgs.hello;
      devShells.default = pkgs.mkShell { buildInputs = [ pkgs.hello ]; };
    };
    flake = {
      # system-agnostic outputs live here
      nixosConfigurations.myhost = inputs.nixpkgs.lib.nixosSystem { … };
    };
  };
```

`flake-parts` uses the NixOS module system — options are type-checked, modules are
composable, and per-system vs flake-wide outputs are cleanly separated. Prefer
`flake-parts` for anything beyond a single crate or small project.

## Gotcha: `allowUnfree` does NOT propagate into `nix develop`

Setting `nixpkgs.config.allowUnfree = true` at the NixOS module level (or in
`nixosConfigurations`) applies to system builds. It does **not** apply when you run
`nix develop` — that shell evaluates `nixpkgs` independently.

**What breaks:** `nix develop` fails with "unfree package … refused" even though your
`nixosConfiguration` builds fine.

**Fixes:**

Option 1 — import nixpkgs with config explicitly in the shell:

```nix
perSystem = { system, ... }:
  let
    pkgs = import inputs.nixpkgs {
      inherit system;
      config.allowUnfree = true;   # ← explicit, applies to this shell
    };
  in {
    devShells.default = pkgs.mkShell { buildInputs = [ pkgs.vscode ]; };
  };
```

Option 2 — set the environment variable before entering the shell:

```bash
NIXPKGS_ALLOW_UNFREE=1 nix develop --impure
```

Note `--impure` is required when reading environment variables inside a flake evaluation.

Option 3 — `nixpkgs.config` overlay in `flake-parts`:

```nix
perSystem = { pkgs, ... }: {
  _module.args.pkgs = import inputs.nixpkgs {
    inherit (pkgs.stdenv) system;
    config.allowUnfree = true;
  };
  devShells.default = pkgs.mkShell { buildInputs = [ pkgs.vscode ]; };
};
```

The root cause: `nixpkgs.legacyPackages` (used by `flake-parts`/`flake-utils`
internally) inherits no config from your NixOS modules.

Deep dive → [anatomy.md](anatomy.md).

## Boundaries

- Defining derivations, overrides, overlays → `nix-packaging`.
- Dev shell toolchains, `direnv`/`use flake`, shell hook patterns → `nix-dev-env`.
- NixOS modules, `nixosConfigurations`, system activation → `nixos`.
