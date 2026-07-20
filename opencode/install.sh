#!/usr/bin/env bash
# Install craft's opencode adapters by symlinking them into an opencode tree.
# Usage: opencode/install.sh [--project | --global]   (default: --project)
set -euo pipefail

# Repo root = parent of this script's dir (opencode/), so the script works from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SCOPE="project"
for arg in "$@"; do
  case "$arg" in
    --project) SCOPE="project" ;;
    --global)  SCOPE="global" ;;
    -h|--help) echo "usage: $0 [--project|--global]"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [ "$SCOPE" = "global" ]; then
  TARGET="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
else
  TARGET="$PWD/.opencode"
fi

# Idempotent symlink: repoint if wrong, leave alone if already correct, never clobber a real file.
link() {  # link <source> <destination>
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  if [ -L "$dst" ]; then
    [ "$(readlink "$dst")" = "$src" ] && { echo "  = $dst"; return; }
    rm "$dst"
  elif [ -e "$dst" ]; then
    echo "  ! $dst exists and is not our symlink — skipping" >&2; return
  fi
  ln -s "$src" "$dst"; echo "  + $dst -> $src"
}

echo "Installing craft opencode adapters into: $TARGET  (scope: $SCOPE)"

# Skills — one symlink per skill dir (target dir may hold other skills).
for d in "$REPO_ROOT"/skills/*/; do
  [ -f "$d/SKILL.md" ] || continue
  link "${d%/}" "$TARGET/skills/$(basename "$d")"
done

# Agents + commands — one symlink per markdown file.
for f in "$SCRIPT_DIR"/agents/*.md;   do [ -e "$f" ] && link "$f" "$TARGET/agents/$(basename "$f")"; done
for f in "$SCRIPT_DIR"/commands/*.md; do [ -e "$f" ] && link "$f" "$TARGET/commands/$(basename "$f")"; done

# Plugin — symlink the whole directory as ONE plugin (opencode auto-loads it from plugins/).
[ -d "$SCRIPT_DIR/plugin" ] && link "$SCRIPT_DIR/plugin" "$TARGET/plugins/craft-rust"

cat <<EOF

Done.
  • Restart opencode (or reopen the project) so it rescans skills/agents/commands/plugins.
  • If opencode does not auto-install the plugin's deps, add @opencode-ai/plugin and
    @opencode-ai/sdk to "$TARGET/package.json" and restart. See opencode/README.md.
EOF
