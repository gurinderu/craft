#!/usr/bin/env bash
# Install craft's opencode adapters by symlinking them into an opencode tree.
# Usage: integrations/opencode/install.sh [--project | --global]   (default: --project)
set -euo pipefail

# Repo root = two levels above this script's dir (integrations/opencode/), so the script works from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# The same two directories as the file system spells them, symlinks resolved: what the stale-link pass compares with.
SCRIPT_DIR_P="$(cd "$SCRIPT_DIR" && pwd -P)"
REPO_ROOT_P="$(cd "$REPO_ROOT" && pwd -P)"

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
MADE=()  # every destination this run links, so the stale-link pass below knows what is current
link() {  # link <source> <destination>
  local src="$1" dst="$2"
  MADE+=("$dst")
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
  # develop drives the review engines through the Workflow tool, which only Claude Code has; codex-review runs each
  # review agent as `codex exec`, which only Codex has. OpenCode's review is the `review` tool (/craft-review).
  case "$(basename "$d")" in develop|codex-review) continue ;; esac
  link "${d%/}" "$TARGET/skills/$(basename "$d")"
done

# Agents + commands — one symlink per markdown file.
for f in "$SCRIPT_DIR"/agents/*.md;   do [ -e "$f" ] && link "$f" "$TARGET/agents/$(basename "$f")"; done
for f in "$SCRIPT_DIR"/commands/*.md; do [ -e "$f" ] && link "$f" "$TARGET/commands/$(basename "$f")"; done

# Plugin — ONE file link to its entry: opencode 1.x discovers only `plugins/*.{ts,js}` files (a directory link
# is never loaded there), 2.x takes files and directories alike. An earlier install's directory link is
# removed as stale below, so 2.x does not load the plugin twice.
[ -d "$SCRIPT_DIR/plugin" ] && link "$SCRIPT_DIR/plugin/index.ts" "$TARGET/plugins/craft-rust.ts"
# The review's footer line on 2.x — a DIRECTORY link: a 2.x TUI plugin is a directory in plugins/ (a single file is
# skipped there), with a `tui` module and no server entry; 1.x ignores directories, so it costs 1.x nothing.
[ -d "$SCRIPT_DIR/plugin/tui" ] && link "$SCRIPT_DIR/plugin/tui" "$TARGET/plugins/craft-review-footer"

# Stale links — one an earlier install made from this checkout (it points at a skill or into integrations/opencode/)
# that this run did not make: its target is gone, or no longer installed (codex-review, the plugin's directory link).
# A link pointing anywhere else, and every real file, is left alone.
# Ownership is judged on the target with its directories' symlinks resolved, so a link made through any spelling of
# this checkout matches. Portable (no `readlink -f`): the nearest existing directory resolved by `pwd -P`, the rest of
# the path — a dead target's missing part — kept as it is.
made() { local d; for d in "${MADE[@]+"${MADE[@]}"}"; do [ "$d" = "$1" ] && return 0; done; return 1; }
resolved() {  # resolved <link>
  local p rest=""
  p="$(readlink "$1")"
  case "$p" in /*) ;; *) p="$(dirname "$1")/$p" ;; esac
  while [ ! -d "$p" ]; do rest="/$(basename "$p")$rest"; p="$(dirname "$p")"; done
  echo "$(cd "$p" && pwd -P)$rest"
}
for l in "$TARGET"/skills/* "$TARGET"/agents/* "$TARGET"/commands/* "$TARGET"/plugins/*; do
  [ -L "$l" ] || continue
  case "$(resolved "$l")" in "$REPO_ROOT_P"/skills/*|"$SCRIPT_DIR_P"/*) ;; *) continue ;; esac
  made "$l" || { rm "$l"; echo "  - $l (stale)"; }
done

# Plugin dependencies — opencode 2.x does not install a plugin directory's package.json (1.x did, through Bun), so
# install the locked closure here when it is missing, or when npm's own record of the installed tree
# (node_modules/.package-lock.json) is older than the lockfile (a pull that moved the lock). A tree with no npm record
# (Bun's, another installer's) that has the dependencies is left alone rather than risk stripping it. Not on every
# run: `npm ci` deletes the tree first, under an opencode that has the plugin loaded. A tree that holds dev packages
# (a development checkout's `npm ci`) is reinstalled whole, so it keeps them.
PLUGIN="$SCRIPT_DIR/plugin"
INSTALLED="$PLUGIN/node_modules/.package-lock.json"
deps_stale() {
  [ -d "$PLUGIN/node_modules/@opencode-ai/plugin" ] || return 0
  [ -f "$INSTALLED" ] && [ "$PLUGIN/package-lock.json" -nt "$INSTALLED" ]
}
dev_tree() { [ -d "$PLUGIN/node_modules/typescript" ] || { [ -f "$INSTALLED" ] && grep -q '"dev": *true' "$INSTALLED"; }; }
if [ -d "$PLUGIN" ] && deps_stale; then
  omit="--omit=dev"
  if dev_tree; then omit=""; fi
  if command -v npm >/dev/null 2>&1; then
    echo "  installing the plugin's locked dependencies (npm ci ${omit:-with dev dependencies})"
    npm ci --prefix "$PLUGIN" ${omit:+"$omit"} --no-audit --no-fund
  else
    echo "  ! npm not found: run 'npm ci --omit=dev' in $PLUGIN before starting opencode" >&2
  fi
fi

cat <<EOF

Done.
  • Restart opencode (or reopen the project) so it rescans skills/agents/commands/plugins.
  • The plugin's dependencies live in its own directory ($SCRIPT_DIR/plugin/node_modules);
    see integrations/opencode/README.md.
EOF
