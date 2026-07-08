# Nix Flake Anatomy

A worked `flake.nix` with `flake-parts`, multi-system support, a `devShells.default`,
and a `packages.default`, plus the full `nix flake` command surface.

## Worked example — `flake-parts` multi-system flake

```nix
{
  description = "my-project — a worked flake-parts example";

  inputs = {
    # Pin to a stable channel; use nixos-unstable for bleeding edge.
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";

    flake-parts.url = "github:hercules-ci/flake-parts";
    flake-parts.inputs.nixpkgs-lib.follows = "nixpkgs";  # dedupe

    # Example extra input — a Rust toolchain overlay.
    rust-overlay.url = "github:oxalica/rust-overlay";
    rust-overlay.inputs.nixpkgs.follows = "nixpkgs";     # dedupe

    # home-manager as an optional system output.
    home-manager.url = "github:nix-community/home-manager/release-24.11";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";     # dedupe
  };

  outputs = inputs @ { self, nixpkgs, flake-parts, rust-overlay, home-manager, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {

      # Platforms this flake supports.
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      # Per-system outputs: packages, devShells, checks, apps.
      perSystem = { pkgs, system, config, ... }:
        let
          # Import nixpkgs with the rust overlay applied.
          pkgs = import nixpkgs {
            inherit system;
            overlays = [ rust-overlay.overlays.default ];
            config.allowUnfree = false;  # flip to true + --impure for unfree pkgs
          };

          # Pin a specific Rust toolchain from the overlay.
          rustToolchain = pkgs.rust-bin.stable.latest.default.override {
            extensions = [ "rust-src" "clippy" "rustfmt" ];
          };
        in
        {
          # ── packages ──────────────────────────────────────────────────────
          packages.default = pkgs.rustPlatform.buildRustPackage {
            pname = "my-project";
            version = "0.1.0";
            src = self;                      # the flake root is the source
            cargoLock.lockFile = ./Cargo.lock;
          };

          # ── dev shells ────────────────────────────────────────────────────
          devShells.default = pkgs.mkShell {
            name = "my-project-dev";
            packages = [
              rustToolchain
              pkgs.cargo-watch
              pkgs.cargo-nextest
              pkgs.nixd          # Nix language server
              pkgs.nil           # alternative Nix LS
            ];
            # Shell hook runs on `nix develop` entry.
            shellHook = ''
              echo "Rust $(rustc --version)"
              echo "Cargo $(cargo --version)"
            '';
          };

          # ── checks (run by `nix flake check`) ────────────────────────────
          checks.clippy = pkgs.runCommand "clippy" {
            buildInputs = [ rustToolchain ];
            src = self;
          } ''
            cd $src
            cargo clippy --all-targets --all-features -- -D warnings
            touch $out
          '';
        };

      # ── Flake-wide (system-agnostic) outputs ──────────────────────────────
      flake = {
        # NixOS system configuration example.
        nixosConfigurations.myhost = nixpkgs.lib.nixosSystem {
          system = "x86_64-linux";
          modules = [
            ./hosts/myhost/configuration.nix
            home-manager.nixosModules.home-manager
            {
              home-manager.useGlobalPkgs = true;
              home-manager.users.alice = import ./home/alice.nix;
            }
          ];
        };

        # Home Manager standalone configuration.
        homeConfigurations."alice@myhost" = home-manager.lib.homeManagerConfiguration {
          pkgs = nixpkgs.legacyPackages.x86_64-linux;
          modules = [ ./home/alice.nix ];
        };

        # Overlays exposed to consumers of this flake.
        overlays.default = final: prev: {
          my-project = self.packages.${prev.system}.default;
        };
      };
    };
}
```

### Why `inputs @` at the start of `outputs`?

```nix
outputs = inputs @ { self, nixpkgs, ... }:
```

The `@` pattern binds the whole attrset to `inputs` while still destructuring the
fields you name. This lets you forward `inputs` to `flake-parts.lib.mkFlake` (which
needs all inputs) without listing every one explicitly.

### Why shadow `pkgs` inside `perSystem`?

`perSystem` receives a `pkgs` argument from `flake-parts` (built from
`nixpkgs.legacyPackages.${system}`), but when you need overlays or `config`, you must
import nixpkgs yourself and reassign `pkgs`. The shadowing is intentional; the
`flake-parts`-provided `pkgs` is discarded.

## `nix flake` command surface

| Command | What it does |
|---------|-------------|
| `nix flake show` | Print the output tree without building anything — great for confirming attribute names |
| `nix flake show .#` | Same, scoped to the current flake |
| `nix flake metadata` | Show resolved inputs, their URLs, and lock status |
| `nix flake check` | Evaluate all `checks.<system>.*` derivations and run `nix-build` on each; also validates `nixosConfigurations` and `packages` |
| `nix flake update` | Bump all inputs to latest, rewrite `flake.lock` |
| `nix flake update nixpkgs` | Bump one named input only |
| `nix flake lock` | Ensure `flake.lock` exists and is consistent without updating |
| `nix flake lock --update-input rust-overlay` | Like `nix flake update <name>` (older style, still valid) |
| `nix flake init` | Scaffold a minimal `flake.nix` in the current directory |
| `nix flake clone <url> --dest ./dir` | Clone a remote flake locally |
| `nix flake archive` | Copy all inputs into the Nix store (useful for offline builds) |

### Useful flags

```bash
# Evaluate with unfree packages allowed (requires --impure):
NIXPKGS_ALLOW_UNFREE=1 nix develop --impure

# Override an input without editing flake.nix:
nix build --override-input nixpkgs github:NixOS/nixpkgs/nixos-unstable

# Show what would change before updating:
nix flake metadata --json | jq '.locks.nodes'

# Inspect a specific output:
nix eval .#packages.x86_64-linux.default.name

# Build verbosely to debug a derivation:
nix build .#packages.x86_64-linux.default -L
```

## Minimal single-file flake (no helper library)

For simple one-package projects, `flake-parts` / `flake-utils` are optional:

```nix
{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f {
        pkgs = nixpkgs.legacyPackages.${system};
        inherit system;
      });
    in {
      packages = forAllSystems ({ pkgs, ... }: {
        default = pkgs.hello;
      });
      devShells = forAllSystems ({ pkgs, ... }: {
        default = pkgs.mkShell { buildInputs = [ pkgs.hello ]; };
      });
    };
}
```

`lib.genAttrs` is the primitive both `flake-utils` and `flake-parts` wrap. Use this
pattern to avoid a dependency when the flake is small; reach for `flake-parts` as soon
as you need modules, type checking, or system-agnostic outputs mixed with per-system ones.
