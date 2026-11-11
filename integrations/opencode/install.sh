#!/usr/bin/env bash
# Install craft's opencode adapters by symlinking them into an opencode tree.
# Usage: integrations/opencode/install.sh [--project | --global]   (default: --project)
set -euo pipefail

# Repo root = two levels above this script's dir (integrations/opencode/), so the script works from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

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
  # develop drives the review engines through the Workflow tool, which only Claude Code has.
  [ "$(basename "$d")" = develop ] && continue
  link "${d%/}" "$TARGET/skills/$(basename "$d")"
done

# Agents + commands — one symlink per markdown file.
for f in "$SCRIPT_DIR"/agents/*.md;   do [ -e "$f" ] && link "$f" "$TARGET/agents/$(basename "$f")"; done
for f in "$SCRIPT_DIR"/commands/*.md; do [ -e "$f" ] && link "$f" "$TARGET/commands/$(basename "$f")"; done

# Plugin — ONE file link to its entry: opencode 1.x discovers only `plugins/*.{ts,js}` files (a directory link
# is never loaded there), 2.x takes files and directories alike. An earlier install's directory link is
# retired, so 2.x does not load the plugin twice.
if [ -d "$SCRIPT_DIR/plugin" ]; then
  old="$TARGET/plugins/craft-rust"
  if [ -L "$old" ] && [ "$(readlink "$old")" = "$SCRIPT_DIR/plugin" ]; then rm "$old"; echo "  - $old (directory link replaced)"; fi
  link "$SCRIPT_DIR/plugin/index.ts" "$TARGET/plugins/craft-rust.ts"
fi

# Plugin dependencies — opencode 2.x does not install a plugin directory's package.json (1.x did, through
# Bun), so install the locked production closure here when it is missing. An existing tree is left alone:
# a checkout that ran `npm ci` for development keeps its dev dependencies.
if [ -d "$SCRIPT_DIR/plugin" ] && [ ! -d "$SCRIPT_DIR/plugin/node_modules/@opencode-ai/plugin" ]; then
  if command -v npm >/dev/null 2>&1; then
    echo "  installing the plugin's locked dependencies (npm ci --omit=dev)"
    npm ci --prefix "$SCRIPT_DIR/plugin" --omit=dev --no-audit --no-fund
  else
    echo "  ! npm not found: run 'npm ci --omit=dev' in $SCRIPT_DIR/plugin before starting opencode" >&2
  fi
fi

cat <<EOF

Done.
  • Restart opencode (or reopen the project) so it rescans skills/agents/commands/plugins.
  • The plugin's dependencies live in its own directory ($SCRIPT_DIR/plugin/node_modules);
    see integrations/opencode/README.md.
EOF
