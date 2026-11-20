# The repo test craft's hooks make, for lib/craft-hook.sh while the craft binary is absent (realm @nick/craft, nodes
# #275, #550): the binary's own is cli/bin/craft/src/hook/role/declared.rs, and lib/craft-hook.test.mjs holds the two
# to the same answers over content/parity/hook-cases.json. Sourced; it reads `input`, `field` and the environment.

# The nearest directory above $1 holding .git; $1 itself when there is none.
repo_root() {
  _r_dir=$1
  while :; do
    [ -e "$_r_dir/.git" ] && { printf '%s' "$_r_dir"; return; }
    case $_r_dir in / | '') printf '%s' "$1"; return ;; esac
    _r_dir=$(dirname "$_r_dir")
  done
}

# Whether the hooks are switched off: CRAFT_ROLE_HOOK=0/off/false/no, or a `craft-role-hook: off` line in the
# repo's AGENTS.md or CLAUDE.md.
switched_off() {
  case $(printf '%s' "${CRAFT_ROLE_HOOK:-}" | tr -d ' \t' | tr 'A-Z' 'a-z') in
    0 | off | false | no) return 0 ;;
  esac
  for _r_f in "$1/AGENTS.md" "$1/CLAUDE.md"; do
    [ -f "$_r_f" ] && tr -d '\r' <"$_r_f" | grep -Eiq '^[ 	]*craft-role-hook:[ 	]*off[ 	]*$' && return 0
  done
  return 1
}

# Whether $1 holds an entry named *$2 (a directory listing, links and directories included).
has_entry() {
  for _r_e in "$1"/*"$2" "$1"/.*"$2"; do
    [ -e "$_r_e" ] || [ -L "$_r_e" ] && return 0
  done
  return 1
}

# Whether the repo at $1 declares its own roles or work rules; $2 `codex` counts Codex's role files too.
role_signs() {
  has_entry "$1/.claude/agents" .md && return 0
  [ "$2" = codex ] && has_entry "$1/.codex/agents" .toml && return 0
  _r_w='[^A-Za-z0-9_]'
  for _r_f in "$1/AGENTS.md" "$1/CLAUDE.md"; do
    [ -f "$_r_f" ] || continue
    grep -Eiq "(^|$_r_w)(pull requests?|code reviews?|reviewers?|review loops?|before merg(e|ing))($_r_w|\$)" "$_r_f" && return 0
    grep -Eq "(^|$_r_w)PRs?($_r_w|\$)" "$_r_f" && return 0
  done
  return 1
}

# The harness: Codex by its PLUGIN_ROOT or the input's turn_id, Claude Code otherwise.
harness() {
  if [ -n "${PLUGIN_ROOT:-}" ] || [ -n "$(field turn_id)" ]; then printf codex; else printf claude-code; fi
}
