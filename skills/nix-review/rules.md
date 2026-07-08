# Nix review — rule catalog

Stable IDs for the severity checklist in `SKILL.md`. A finding that maps to a rule **cites its ID**
(e.g. `PUR-001`) so it is addressable, dedup-able across rounds, and greppable in a report. IDs are
append-only: never renumber or reuse a retired ID.

This catalog **mirrors** the `SKILL.md` checklist — the checklist is the prose, this is the index.
Severities match. Not every finding maps to a catalog rule (novel issues are fine and encouraged —
report them without an ID).

| ID | Severity | Rule | Fix skill |
|---|---|---|---|
| **PUR-001** | HIGH | Impure builtin in derivation (`builtins.currentTime`, `builtins.getEnv`, `<nixpkgs>` channel path) — breaks reproducibility | `nix-packaging` |
| **PUR-002** | HIGH | Fetcher without fixed output hash (`fetchgit`/`fetchurl` missing `sha256`/`hash`) | `nix-packaging` |
| **REP-001** | HIGH | Flake input unpinned or channel-based (no `flake.lock` entry / `follows` missing) | `nix-flakes` |
| **REP-002** | MEDIUM | Import-from-derivation (IFD) forcing eval-time builds, or `--impure` reliance | `nix-flakes` |
| **INJ-001** | CRITICAL | Untrusted value interpolated directly into a build phase or shell script without sanitization | `nix-packaging` |
| **PKG-001** | HIGH | Wrong or missing dependency hash (`cargoHash`/`vendorHash`/`npmDepsHash`) | `nix-packaging` |
| **PKG-002** | MEDIUM | Missing `meta` (`description`/`license`/`mainProgram`) on a package | `nix-packaging` |
| **DEV-001** | MEDIUM | `allowUnfree`/config set in `flake.nix` but not propagated to `nix develop` | `nix-dev-env` |
| **MOD-001** | CRITICAL | Secret embedded as plaintext string inside a derivation or store path instead of managed by agenix/sops-nix | `nixos` |
| **MOD-002** | MEDIUM | NixOS/HM option without a `type` or `default`; non-cross-platform assumption | `nixos` |
| **MNT-001** | MEDIUM | Dead code (`deadnix`) / anti-idiom (`statix`) / needless `rec`/`with` | `nix-dev-env` |
| **DEP-001** | MEDIUM | Flake input pin stale or floating where it should be locked | `nix-flakes` |

## Adding a rule

Append a new ID under the right prefix (next free number); never renumber existing rows. Keep the
row in sync with the `SKILL.md` checklist prose. Prefixes: `PUR` purity · `REP` reproducibility ·
`INJ` injection · `PKG` packaging · `DEV` dev-env · `MOD` modules · `MNT` maintainability ·
`DEP` dependencies.
