#!/bin/sh
# craft's PreToolUse hook on the Bash tool (integrations/claude-code/hooks/hooks.json; Claude Code and Codex run the
# same file): hands the hook input on stdin to `craft hook pre-pr`, which says when a `gh pr create` opens a pull
# request on a head with no full craft review (realm @nick/craft, node #541), and prints what it says. Every Bash call
# passes through here, so a cheap text test comes first and the binary runs only when the input may hold a
# `gh pr create`; the binary decides.
#
# It runs the binary of this plugin version from the cache bin/craft and lib/craft-bin.mjs fill
# (~/.craft/bin/<version>/craft), or CRAFT_BIN, and never downloads it: a hook has 10 s, a download can take longer,
# and one killed at the limit leaves its partial fetch behind. Not through bin/craft: the Claude Code delivery has no
# bin/, since Claude Code puts a plugin's bin/ on the session's PATH. When the binary is not there or fails, it says so
# in one line to the human (systemMessage) rather than staying silent. It warns, never blocks: it always exits 0.
set -u

version=0.54.1 # x-release-please-version

input=$(cat)
case $input in
  *gh*pr*create*) ;;
  *) exit 0 ;;
esac

# One line for the human, the reason escaped for a JSON string.
notice() {
  why=$(printf '%s' "$1" | sed 's/[\\"]/\\&/g' | tr -d '\000-\037')
  printf '{"systemMessage":"craft: the pre-PR review check did not run (%s), so whether this head has a full craft review is unknown."}\n' "$why"
  exit 0
}

if [ -n "${CRAFT_BIN:-}" ]; then
  bin=$CRAFT_BIN
elif [ -n "${HOME:-}" ]; then
  bin=$HOME/.craft/bin/$version/craft
else
  notice "HOME is not set, so there is no ~/.craft/bin/$version"
fi
[ -f "$bin" ] && [ -x "$bin" ] || notice "the craft binary $version is not on this machine yet ($bin); a craft review fetches it"
out=$(printf '%s' "$input" | "$bin" hook pre-pr 2>/dev/null) || notice "the craft binary $version failed"
printf '%s' "$out"
exit 0
