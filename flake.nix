{
  description = "craft's development shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    flake-utils.url = "github:numtide/flake-utils";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      rust-overlay,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ rust-overlay.overlays.default ];
        };
        # The CLI's pinned toolchain, with the editor's sources and language
        # server at the same version as rustc.
        rust = (pkgs.rust-bin.fromRustupToolchainFile ./cli/rust-toolchain.toml).override {
          extensions = [
            "rust-analyzer"
            "rust-src"
          ];
        };
      in
      {
        formatter = pkgs.nixfmt;

        # mkShell brings the C compiler and linker the build scripts need.
        devShells.default = pkgs.mkShell {
          name = "craft-dev";
          packages = [
            rust
            # CI's Node pin.
            pkgs.nodejs_22
            # The mutants an implementation brief asks for on its diff.
            pkgs.cargo-mutants
            pkgs.jq
            pkgs.nixfmt
          ];
        };
      }
    );
}
