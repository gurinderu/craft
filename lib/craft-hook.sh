#!/bin/sh
# craft's role hooks in integrations/claude-code/hooks/hooks.json (which the Codex manifest names too): hands the hook
# input on stdin to `craft hook <name>` — session-start, user-prompt, subagent-start or reviewer-dispatch (realm
# @nick/craft, node #538; in the binary, not Node: #537) — and prints what it says.
#
# Like lib/pr-opened-hook.sh, it runs the binary of this plugin version from the cache bin/craft and lib/craft-bin.mjs
# fill (~/.craft/bin/<version>/craft), or CRAFT_BIN, and never downloads it: a hook has its time limit, a download can
# take longer, and one killed at the limit leaves its partial fetch behind. When the binary is not there, the start hook
# says so to the human (systemMessage) and the others in one line on stderr, so a prompt does not repeat it; when the
# binary fails, every hook says so to the human. It never blocks: it always exits 0.
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

# A string escaped for JSON.
esc() {
  printf '%s' "$1" | sed 's/[\\"]/\\&/g' | tr -d '\000-\037'
}

# One line saying why the hook did not run: to the human when $2 is `loud` or at the session's start, else on stderr.
# A Codex session start with no binary (PLUGIN_ROOT set, $2 `missing`) also tells the model how the first review
# fetches it, as the binary's own readiness line does once it runs (cli/bin/craft/src/hook/role/readiness.rs).
notice() {
  why=$(esc "$1")
  if [ "$hook" = session-start ] && [ "$2" = missing ] && [ -n "${PLUGIN_ROOT:-}" ]; then
    wrapper=$(esc "${PLUGIN_ROOT%/}/bin/craft")
    printf '{"systemMessage":"craft: the %s hook did not run: %s.","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"craft: the craft binary %s is not in ~/.craft/bin yet. When you run craft'"'"'s review (the codex-review skill), its first run downloads it, which needs the network and writes outside the workspace: then run `sh \\"%s\\" review run --backend codex …` with escalated permissions and ask the user to approve it. This is not a request to start a review now."}}\n' "$hook" "$why" "$version" "$wrapper"
  elif [ "$2" = loud ] || [ "$hook" = session-start ]; then
    printf '{"systemMessage":"craft: the %s hook did not run: %s."}\n' "$hook" "$why"
  else
    printf 'craft: the %s hook did not run: %s.\n' "$hook" "$why" >&2
  fi
  exit 0
}

if [ -n "${CRAFT_BIN:-}" ]; then
  bin=$CRAFT_BIN
elif [ -n "${HOME:-}" ]; then
  bin=$HOME/.craft/bin/$version/craft
else
  notice "HOME is not set, so there is no ~/.craft/bin/$version" quiet
fi
[ -f "$bin" ] && [ -x "$bin" ] || notice "the craft binary $version is not on this machine yet ($bin); a craft review fetches it" missing
out=$("$bin" hook "$hook" 2>/dev/null)
code=$?
[ "$code" -eq 0 ] || notice "the craft binary $version failed (exit $code)" loud
[ -z "$out" ] || printf '%s\n' "$out"
exit 0
