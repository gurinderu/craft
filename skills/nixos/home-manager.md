# Home Manager

Home Manager manages per-user configuration — dotfiles, shell settings, programs,
environment variables — using the same NixOS module system. It runs on NixOS (Linux),
nix-darwin (macOS), and standalone on any system with Nix installed.

## Standalone vs NixOS-module

### Standalone

Home Manager is invoked directly by the user via the `home-manager` CLI. The
`homeConfigurations` output in a flake is the entry point:

```nix
# flake.nix
inputs.home-manager.url = "github:nix-community/home-manager";
inputs.home-manager.inputs.nixpkgs.follows = "nixpkgs";

outputs = { nixpkgs, home-manager, ... }:
  let
    system = "x86_64-linux";
    pkgs   = nixpkgs.legacyPackages.${system};
  in {
    homeConfigurations."alice@workstation" = home-manager.lib.homeManagerConfiguration {
      inherit pkgs;
      modules = [ ./home/alice.nix ];
    };
  };
```

Apply with:

```bash
home-manager switch --flake .#"alice@workstation"
```

This mode is useful when Home Manager is the *only* Nix tool managing the machine (e.g.
a non-NixOS Linux or a macOS machine without nix-darwin).

### NixOS module (integrated)

When the host is already managed by NixOS or nix-darwin, embed Home Manager as a
NixOS/darwin module. The system activation (`nixos-rebuild switch`) runs Home Manager
activation for each declared user automatically.

```nix
# In nixosConfigurations.myhost modules list:
inputs.home-manager.nixosModules.home-manager
{
  home-manager.useGlobalPkgs   = true;   # share the system nixpkgs instance
  home-manager.useUserPackages = true;   # install to /etc/profiles instead of ~/.nix-profile

  home-manager.users.alice = import ./home/alice.nix;
}
```

For nix-darwin, substitute `inputs.home-manager.darwinModules.home-manager`.

**Prefer the integrated mode** on managed hosts: a single `nixos-rebuild switch` (or
`darwin-rebuild switch`) activates both system and user config atomically.

## Per-user configuration module

A Home Manager user module follows the same `{ config, lib, pkgs, ... }:` function
shape as a NixOS module. Minimal example:

```nix
{ config, lib, pkgs, ... }:

{
  # Required: tell Home Manager which account this manages
  home.username      = "alice";
  home.homeDirectory = "/home/alice";   # or "/Users/alice" on macOS

  # Declare packages available in the user environment
  home.packages = with pkgs; [
    ripgrep
    fd
    jq
    htop
  ];

  # Enable and configure programs via the programs.* namespace
  programs.git = {
    enable    = true;
    userName  = "Alice Example";
    userEmail = "alice@example.com";
    extraConfig.init.defaultBranch = "main";
  };

  programs.zsh = {
    enable            = true;
    enableCompletion  = true;
    autosuggestion.enable = true;
    syntaxHighlighting.enable = true;
    shellAliases = {
      ll = "ls -lAh";
      g  = "git";
    };
  };

  programs.direnv = {
    enable            = true;
    nix-direnv.enable = true;   # fast nix-shell caching via nix-direnv
  };

  # Raw dotfiles: home.file copies a file into $HOME
  home.file.".config/my-tool/config.toml".text = ''
    [settings]
    theme = "dark"
  '';

  # Home Manager state version — pin to the version you first installed
  home.stateVersion = "24.05";
}
```

`programs.<x>.enable = true` activates the module for program `x`, which typically
installs the package and writes its config files. Check `home-manager-option-search`
or `man home-configuration.nix` for the full list.

## Cross-platform (Linux + Darwin)

A single Home Manager module can target both Linux and macOS. Guard
platform-specific settings with `pkgs.stdenv.isLinux` / `pkgs.stdenv.isDarwin`:

```nix
{ config, lib, pkgs, ... }:

{
  home.username = "alice";
  # homeDirectory differs by platform — set it conditionally
  home.homeDirectory =
    if pkgs.stdenv.isDarwin
    then "/Users/alice"
    else "/home/alice";

  home.packages = with pkgs; [
    ripgrep fd jq
  ];

  programs.git.enable = true;

  # Linux-only: a systemd user service
  systemd.user.services.my-sync = lib.mkIf pkgs.stdenv.isLinux {
    Unit.Description    = "Sync data";
    Service.ExecStart   = "${pkgs.rclone}/bin/rclone sync ~/data remote:data";
    Install.WantedBy    = [ "default.target" ];
  };

  # macOS-only: Homebrew-managed GUI app (managed outside Nix)
  # For nix-darwin, homebrew.* options live in the darwin module, not HM.
  # Here we can set macOS-specific defaults via home.activation if needed.
  home.activation.setDefaults = lib.mkIf pkgs.stdenv.isDarwin
    (lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      defaults write com.apple.finder AppleShowAllFiles -bool true
    '');

  home.stateVersion = "24.05";
}
```

To share this module across multiple hosts in a flake, pass it to each
`homeManagerConfiguration` (standalone) or each `home-manager.users.<name>` entry
(integrated), relying on the `pkgs.stdenv` guards for divergence.

## Quick reference

| Option | Purpose |
|--------|---------|
| `home.packages` | Packages installed in the user profile |
| `programs.<x>.enable` | Enable a managed program (installs + configures) |
| `home.file.<path>.text` | Write a file into `$HOME` as literal text |
| `home.file.<path>.source` | Copy a file from the store into `$HOME` |
| `home.sessionVariables` | Environment variables for interactive sessions |
| `home.shellAliases` | Shell aliases applied to all enabled shells |
| `systemd.user.services.<name>` | (Linux) Define a systemd user unit |
| `home.activation.<name>` | Run an arbitrary script at activation time |
| `home.stateVersion` | Pin to the HM version at first install — do not update |

## Secrets in Home Manager

The same rule applies as for NixOS modules: **never put a secret value in a Home
Manager option**. Use agenix or sops-nix (see SKILL.md) and reference the decrypted
path. For user-scoped secrets with agenix, set `age.secrets.<name>.owner` to the user,
or use `home-manager`'s own `sops.secrets` support via `sops-nix`'s HM module.
