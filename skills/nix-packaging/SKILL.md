---
name: nix-packaging
description: >-
  Nix derivations — stdenv.mkDerivation and the phase model, fixed-output hashes for src fetchers,
  language-builder dependency hashes (cargoHash, vendorHash, npmDepsHash), the iterative
  lib.fakeHash → copy-real-hash workflow, and meta attributes. Use when writing, debugging, or
  reviewing a derivation, packaging a Rust/Go/Python/Node project for Nix, or dealing with hash
  mismatches at build time. Triggers: mkDerivation, buildRustPackage, buildGoModule,
  buildPythonPackage, buildNpmPackage, vendorHash, cargoHash, fetchFromGitHub, meta, nix-build,
  derivation.
---

# Nix Packaging

A derivation is the fundamental build unit in Nix — a description of how to produce a store path
from inputs. `stdenv.mkDerivation` is the generic builder; language ecosystems add
`buildRustPackage`, `buildGoModule`, etc. on top of it. The rules are the same everywhere: every
input must be pinned with a hash, and the build sandbox must never reach the network.

## `stdenv.mkDerivation` and the phase model

The minimal shape:

```nix
{ lib, stdenv, fetchFromGitHub }:

stdenv.mkDerivation {
  pname   = "mytool";
  version = "1.2.3";

  src = fetchFromGitHub {
    owner  = "example";
    repo   = "mytool";
    rev    = "v1.2.3";
    hash   = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  };

  # build inputs available at compile time
  nativeBuildInputs = [ ];
  # runtime dependencies linked into the output
  buildInputs = [ ];

  meta = with lib; {
    description = "A short, imperative sentence describing the tool";
    license     = licenses.mit;
    mainProgram = "mytool";   # the binary nix run exposes
    maintainers = [ ];
  };
}
```

Nix runs the build through a sequence of **phases**. The defaults handle the most common patterns;
override only what you need:

| Phase | Default action | Override hook |
|-------|---------------|---------------|
| `unpackPhase` | `tar xf $src` (or `cp` for single files) | `unpackPhase = "...";` |
| `patchPhase` | Apply `patches = [ ]` list | `patchPhase = "...";` |
| `configurePhase` | `./configure --prefix=$out` | `configurePhase = "...";` |
| `buildPhase` | `make` | `buildPhase = "...";` |
| `checkPhase` | `make check` (skipped unless `doCheck = true`) | `checkPhase = "...";` |
| `installPhase` | `make install` | `installPhase = "...";` |
| `fixupPhase` | patchelf, strip, wrap executables | rarely overridden |

Override a phase with a Bash string. Inside the string, `$out` is the derivation's store path:

```nix
installPhase = ''
  install -Dm755 result/mytool $out/bin/mytool
'';
```

## Fixed-output hashes — src fetchers

Every `fetch*` function is a **fixed-output derivation**: it may access the network, but the result
must match the declared hash — any mismatch aborts the build. This makes fetches reproducible.

Common fetchers and their hash field:

```nix
# GitHub tarball
src = fetchFromGitHub {
  owner = "org"; repo = "proj"; rev = "v1.0.0";
  hash = "sha256-…";   # SRI format, preferred
};

# Generic URL
src = fetchzip {
  url    = "https://example.com/proj-1.0.0.tar.gz";
  sha256 = "0000000000000000000000000000000000000000000000000000";   # base32 ok too
};
```

Use `hash` (SRI, `sha256-<base64>`) on new code — it is the current preferred form. The older
`sha256` (base32 / hex) works but is being phased out.

## Language-builder dependency hashes

Language builders need a **second hash** for vendored dependencies. This hash covers the full
dependency tree fetched separately from the source, so it is also a fixed-output derivation.

| Builder | Dep-hash field | What it covers |
|---------|---------------|----------------|
| `buildRustPackage` | `cargoHash` (current) or `vendorHash` (alias) | `Cargo.lock` dependency tree |
| `buildGoModule` | `vendorHash` | Go module graph (`go.sum`) |
| `buildPythonPackage` | no single field; use `fetchPypi` for src or `poetry2nix` / `mach-nix` | — |
| `buildNpmPackage` | `npmDepsHash` | `package-lock.json` dependency tree |

## The iterative `lib.fakeHash` → copy-real-hash flow

You never know the hash before the first build. The workflow:

1. Set the hash field to `lib.fakeHash` (a known-wrong but syntactically valid hash placeholder).
2. Run `nix build` (or `nix-build`). The build **fails** with an error like:
   ```
   error: hash mismatch in fixed-output derivation '/nix/store/…':
     specified: sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
     got:       sha256-<actual base64 hash>
   ```
3. Copy the `got:` value back into the expression, replacing `lib.fakeHash`.
4. Run `nix build` again — it succeeds.

Repeat for each hash field independently (src hash, then dep hash).

```nix
# Step 1 — placeholder
cargoHash = lib.fakeHash;

# Step 3 — paste the "got:" value
cargoHash = "sha256-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=";
```

`lib.fakeHash` is defined in `<nixpkgs/lib>` — import `lib` from pkgs or the nixpkgs argument:

```nix
{ lib, pkgs, buildRustPackage, ... }:
```

## `meta` — required in review

Every derivation exposed as a package **must** carry a `meta` block. The three fields checked in
review:

```nix
meta = with lib; {
  description = "Serve HTTP static files from a local directory";   # imperative, no trailing dot
  license     = licenses.mit;        # from lib.licenses — use the attribute, not a string
  mainProgram = "serve";             # enables `nix run` without specifying the binary name
  maintainers = with maintainers; [ ]; # optional but conventional
  homepage    = "https://github.com/org/serve";                     # optional, good practice
};
```

Common `lib.licenses` values: `mit`, `asl20`, `gpl3Only`, `gpl3Plus`, `bsd2`, `bsd3`, `mpl20`,
`unfree`.

## Never fetch impurely at build time

The Nix sandbox **blocks network access** during a normal derivation build. This means:

- Do **not** run `cargo fetch`, `npm install`, `pip install`, or `go mod download` inside
  `buildPhase` or `installPhase` without pre-vendoring.
- Language builders handle this by fetching dependencies as a **separate fixed-output derivation**
  (keyed by the dep hash) before the main build runs. The main build then works offline against the
  pre-fetched vendor directory.
- A bare `runCommand` or `mkDerivation` has no such mechanism — it gets no network. If you need
  deps, use the appropriate language builder.

Impure fetches break on every `nix build` run on a machine that hasn't cached the result, and they
make the build non-reproducible. They are a blocking finding in `nix-review`.

## Details → `builders.md`

Minimal correct derivations for each builder with all required hash fields:
[builders.md](builders.md)

## Boundaries

- Wiring the derivation into a flake's `packages` output, pinning nixpkgs, `follows` →
  `nix-flakes`.
- Review rubric for packaging quality, hash hygiene, meta completeness → `nix-review` (consumes
  this skill's rules).
- Dev shells, `mkShell`, `nix develop` patterns → `nix-dev-env`.
- NixOS module options, `nixosConfigurations` → `nixos`.
