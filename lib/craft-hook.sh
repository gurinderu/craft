#!/bin/sh
# craft's role hooks in integrations/claude-code/hooks/hooks.json (which the Codex manifest names too): hands the hook
# input on stdin to `craft hook <name>` — session-start, user-prompt, subagent-start or reviewer-dispatch (realm
# @nick/craft, node #538; in the binary, not Node: #537) — and prints what it says.
#
# It runs the binary of this plugin version from the cache (~/.craft/bin/<version>/craft), or CRAFT_BIN, and never
# waits for a download: a hook has its time limit. While the binary is absent (realm @nick/craft, node #550):
#   - in a repo with role signs and the switch on (the repo test below, the binary's own in
#     cli/bin/craft/src/hook/role/declared.rs, held to it by lib/craft-hook.test.mjs), the start hook starts the
#     download in the background (lib/craft-fetch.sh, a session of its own, its output in ~/.craft/bin/<version>.log)
#     and tells the human in one line; the others say so on stderr; elsewhere it says nothing (#276);
#   - under Codex with the switch on, the start hook says the sandbox line itself when `codex sandbox true` fails to set
#     up its sandbox, as the binary's readiness line does (cli/bin/craft/src/hook/role/readiness.rs).
# When the binary fails, the human hears it once per session (a marker under ~/.craft/hook-failed/). It never blocks:
# it always exits 0. Windows is not covered (no sh), as for lib/pr-opened-hook.sh.
set -u

version=0.55.0 # x-release-please-version

hook=${1:-}
case $hook in
  session-start | user-prompt | subagent-start | reviewer-dispatch) ;;
  *)
    printf 'craft: no craft hook named "%s".\n' "$hook" >&2
    exit 0
    ;;
esac
here=$(cd "$(dirname "$0")/.." && pwd -P)
input=$(cat)

# A string escaped for JSON.
esc() {
  printf '%s' "$1" | sed 's/[\\"]/\\&/g' | tr -d '\000-\037'
}

# A string field of the input, '' when absent (the paths and ids the harness writes carry no escapes).
field() {
  printf '%s' "$input" | tr -d '\n' | sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"\\]*\)".*/\1/p'
}

. "$here/lib/craft-hook-repo.sh"

if [ -n "${CRAFT_BIN:-}" ]; then
  bin=$CRAFT_BIN
elif [ -n "${HOME:-}" ]; then
  bin=$HOME/.craft/bin/$version/craft
else
  printf 'craft: the %s hook did not run: HOME is not set, so there is no ~/.craft/bin/%s.\n' "$hook" "$version" >&2
  exit 0
fi

if ! { [ -f "$bin" ] && [ -x "$bin" ]; }; then
  . "$here/lib/craft-hook-absent.sh"
  absent
  exit 0
fi

out=$(printf '%s' "$input" | "$bin" hook "$hook" 2>/dev/null)
code=$?
if [ "$code" -ne 0 ]; then
  why=$(esc "the craft binary $version failed (exit $code)")
  session=$(field session_id | tr -c 'A-Za-z0-9._-' '_')
  mark=${HOME:-/nonexistent}/.craft/hook-failed/${session:-none}
  if [ -n "$session" ] && [ -e "$mark" ]; then
    printf 'craft: the %s hook did not run: %s.\n' "$hook" "$why" >&2
  else
    [ -z "$session" ] || { mkdir -p "${mark%/*}" && : >"$mark"; } 2>/dev/null
    printf '{"systemMessage":"craft: the %s hook did not run: %s."}\n' "$hook" "$why"
  fi
  exit 0
fi
[ -z "$out" ] || printf '%s\n' "$out"
exit 0
