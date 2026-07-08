# Builder Reference

One minimal correct derivation per builder. Copy, fill in the real hashes via the
`lib.fakeHash` → copy-real-hash flow described in `SKILL.md`, and extend as needed.

---

## `buildRustPackage`

Uses `cargoHash` to vendor the Cargo dependency tree before the main build. The sandbox
blocks network access during `buildPhase`, so all crates must be pre-fetched.

```nix
{ lib, rustPlatform, fetchFromGitHub }:

rustPlatform.buildRustPackage {
  pname   = "ripgrep";
  version = "14.1.1";

  src = fetchFromGitHub {
    owner = "BurntSushi";
    repo  = "ripgrep";
    rev   = "14.1.1";
    hash  = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    # ^ step 1: set to lib.fakeHash, build, paste the "got:" value here
  };

  # Covers the entire Cargo.lock dependency graph.
  # Set to lib.fakeHash first; paste the "got:" hash after the first failed build.
  cargoHash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

  meta = with lib; {
    description = "A fast line-oriented search tool";
    license     = licenses.mit;
    mainProgram = "rg";
  };
}
```

**Notes:**
- `rustPlatform` is `pkgs.rustPlatform`; it bundles the default Rust toolchain from nixpkgs.
- For a custom toolchain (rust-overlay, etc.), pass `rustPlatform = pkgs.makeRustPlatform { … }`.
- `cargoHash` replaces the older two-field pattern (`cargoSha256` / separate `vendorHash`
  argument to `cargoSetupHook`). Use `cargoHash` on new derivations.
- Run `nix build` twice: once to get the src hash, once to get the cargoHash (the dep fetch
  happens after the src is unpacked and `Cargo.lock` is read).

---

## `buildGoModule`

Vendors Go modules via a fixed-output derivation keyed by `vendorHash`.

```nix
{ lib, buildGoModule, fetchFromGitHub }:

buildGoModule {
  pname   = "age";
  version = "1.2.0";

  src = fetchFromGitHub {
    owner = "FiloSottile";
    repo  = "age";
    rev   = "v1.2.0";
    hash  = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  };

  # Covers go.sum / the full module graph.
  # Set to lib.fakeHash; paste the "got:" hash after the first build attempt.
  vendorHash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

  meta = with lib; {
    description = "A simple, modern and secure file encryption tool";
    license     = licenses.bsd3;
    mainProgram = "age";
  };
}
```

**Notes:**
- If a project has no external Go dependencies, set `vendorHash = null;` — the build skips
  the vendoring step.
- `proxyVendor = true;` forces vendoring even when a `vendor/` directory is already present
  in the source (useful when it is outdated or incomplete).

---

## `buildPythonPackage`

Python packaging in nixpkgs uses `buildPythonPackage` (via `python3Packages.callPackage`).
Source is usually fetched from PyPI with `fetchPypi` — which requires only a `sha256`
because PyPI provides stable checksums.

```nix
{ lib
, buildPythonPackage
, fetchPypi
, setuptools
, requests  # example runtime dep from python3Packages
}:

buildPythonPackage rec {
  pname   = "httpie";
  version = "3.2.4";
  pyproject = true;

  src = fetchPypi {
    inherit pname version;
    hash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    # ^ set to lib.fakeHash, build, paste the "got:" value
  };

  build-system = [ setuptools ];

  dependencies = [ requests ];

  # Unit tests often require network or extra test deps; disable in the derivation
  # and run them separately if needed.
  doCheck = false;

  meta = with lib; {
    description = "User-friendly cURL replacement";
    license     = licenses.bsd3;
    mainProgram = "http";
  };
}
```

**Notes:**
- `pyproject = true` tells the builder to use `pip`/`flit`/`hatch` PEP 517 build isolation
  instead of the legacy `setup.py` path.
- For complex lockfile-based projects, `poetry2nix` or `uv2nix` generate the full closure
  from a `poetry.lock` / `uv.lock` automatically — no per-package hash needed.
- Never run `pip install` in `buildPhase` or `installPhase`; that requires network access.

---

## `buildNpmPackage`

Vendors npm dependencies via `npmDepsHash`, derived from `package-lock.json`.
The npm-from-source pattern below is adapted from
[YPares/agent-skills `package-npm-nix`](https://github.com/YPares/agent-skills) (MIT).

```nix
{ lib, buildNpmPackage, fetchFromGitHub }:

buildNpmPackage {
  pname   = "prettier";
  version = "3.3.3";

  src = fetchFromGitHub {
    owner = "prettier";
    repo  = "prettier";
    rev   = "3.3.3";
    hash  = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  };

  # Covers the full package-lock.json dependency graph.
  # Set to lib.fakeHash; paste the "got:" hash after the first failed build.
  npmDepsHash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

  # If the package produces a dist/ that needs to be installed:
  installPhase = ''
    runHook preInstall
    install -Dm755 bin/prettier.cjs $out/bin/prettier
    runHook postInstall
  '';

  meta = with lib; {
    description = "An opinionated code formatter";
    license     = licenses.mit;
    mainProgram = "prettier";
  };
}
```

**Notes:**
- `buildNpmPackage` runs `npm ci --offline` against a pre-fetched node_modules store path
  (keyed by `npmDepsHash`). The main build never touches the network.
- A `package-lock.json` (lockfile v2 or v3) **must** be present in the source — without it,
  `buildNpmPackage` cannot reproduce the exact dependency tree.
- If the upstream repo omits the lockfile, vendor it yourself and include it via a patch or
  by adding it to `src` with `fetchurl` + `unpackPhase` override.
- Do **not** use `runCommand` + `npm install` as an alternative — that requires network access
  inside the sandbox and will fail.

---

## Plain `mkDerivation` with explicit phases

Use this when no language builder fits — wrapping a pre-built binary, processing a data file,
or building a project with a custom build system.

```nix
{ lib, stdenv, fetchurl, makeWrapper, zlib }:

stdenv.mkDerivation rec {
  pname   = "mytool";
  version = "2.0.0";

  src = fetchurl {
    url    = "https://example.com/mytool-${version}.tar.gz";
    hash   = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  };

  nativeBuildInputs = [ makeWrapper ];   # tools needed at build time only
  buildInputs       = [ zlib ];          # libraries linked into the binary (runtime)

  # Override only the phases you need; the rest run their defaults.
  configurePhase = ''
    runHook preConfigure
    ./configure --prefix=$out --without-docs
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    make -j$NIX_BUILD_CORES
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    make install
    # Wrap the binary so it finds its runtime deps even outside nix develop
    wrapProgram $out/bin/mytool \
      --prefix LD_LIBRARY_PATH : ${lib.makeLibraryPath [ zlib ]}
    runHook postInstall
  '';

  meta = with lib; {
    description = "An example tool built with a custom Makefile";
    license     = licenses.gpl3Only;
    mainProgram = "mytool";
  };
}
```

**Notes:**
- Always call `runHook preFoo` / `runHook postFoo` inside overridden phases — this preserves
  the hook extension points that overlays and callPackage overrides rely on.
- `nativeBuildInputs` = build-time tools (compilers, code generators, `makeWrapper`);
  `buildInputs` = runtime libraries. The distinction matters for cross-compilation.
- `$NIX_BUILD_CORES` is set by the sandbox to the number of available CPUs — use it with
  `-j` to get parallel builds.
- Never shadow the `version` function argument with a `let version = …` binding — use `rec`
  on the attrset if you need self-reference (as shown above), or pass `version` explicitly.
