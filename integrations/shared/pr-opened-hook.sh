#!/bin/sh
# craft's PostToolUse hook on the Bash tool (integrations/claude-code/hooks/hooks.json, which the Codex manifest names
# too; whether Codex runs it is unobserved): hands the hook input on stdin to `craft hook pr-opened`, which says when a
# Bash call opened a pull request whose head has no full craft review (realm @nick/craft, node #541), and prints what
# it says. Every Bash call passes through here, so a cheap text test comes first: the input must name `pr create` or
# `pr new` and hold a pull request's numbered URL (`/pull/<digit>`, which a push's `/pull/new/<branch>` is not) before
# anything is said, the binary's absence included; the binary decides, reading the command and its output apart.
#
# It runs the binary of this plugin version from the cache bin/craft and integrations/shared/craft-bin.mjs fill
# (~/.craft/bin/<version>/craft), or CRAFT_BIN, and never downloads it: a hook has its time limit, a download can take
# longer, and one killed at the limit leaves its partial fetch behind. Not through bin/craft: the Claude Code delivery
# has no bin/, since Claude Code puts a plugin's bin/ on the session's PATH. When the binary is not there or fails, it
# says so in one line to the human (systemMessage) rather than staying silent. It warns, never blocks: it always
# exits 0.
set -u

version=0.59.0 # x-release-please-version

input=$(cat)
# Each test one substring between two stars: dash matches a glob with more stars by backtracking, which a long output
# makes slow.
case $input in
  *'pr create'* | *'pr new'*) ;;
  *) exit 0 ;;
esac
case $input in
  */pull/[0-9]*) ;;
  *) exit 0 ;;
esac

# One line for the human, the reason escaped for a JSON string.
notice() {
  why=$(printf '%s' "$1" | sed 's/[\\"]/\\&/g' | tr -d '\000-\037')
  printf '{"systemMessage":"craft: could not check the opened PR for a full craft review: %s."}\n' "$why"
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
out=$(printf '%s' "$input" | "$bin" hook pr-opened 2>/dev/null) || notice "the craft binary $version failed"
printf '%s' "$out"
exit 0
