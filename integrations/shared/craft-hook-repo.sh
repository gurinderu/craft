# The repo test craft's hooks make, for when the craft binary is absent (realm @nick/craft, nodes #275, #550): the
# binary's own is cli/bin/craft/src/hook/role/declared.rs, and integrations/shared/craft-hook.test.mjs holds the two to the same
# `found` over every case of content/parity/hook-cases.json, so a rule changed on one side alone fails a test.
#
# Sourced by integrations/shared/craft-hook.sh, or run: `sh integrations/shared/craft-hook-repo.sh found|speaks <dir> <harness>` (the OpenCode work
# hook asks `speaks` before it starts a download).

# The nearest directory above $1 holding .git; $1 itself when there is none.
repo_root() {
  _r_dir=$1
  while :; do
    [ -e "$_r_dir/.git" ] && {
      printf '%s' "$_r_dir"
      return
    }
    case $_r_dir in
      / | '' | .)
        printf '%s' "$1"
        return
        ;;
    esac
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

# The entries of $1 named *$2 as `$4/<name>`, sorted bytewise; $3 `own` leaves out symlinks.
_r_list() {
  for _r_e in "$1"/* "$1"/.*; do
    _r_n=${_r_e##*/}
    case $_r_n in
      . | ..) continue ;;
      *"$2") ;;
      *) continue ;;
    esac
    [ -e "$_r_e" ] || [ -L "$_r_e" ] || continue
    [ "$3" = own ] && [ -L "$_r_e" ] && continue
    printf '%s/%s\n' "$4" "$_r_n"
  done | LC_ALL=C sort
}

# The rules files among AGENTS.md and CLAUDE.md (one reached twice, a link, once) that name the review process.
_r_rules() {
  _r_w='[^A-Za-z0-9_]'
  for _r_n in AGENTS.md CLAUDE.md; do
    _r_f=$1/$_r_n
    [ -f "$_r_f" ] || continue
    [ "$_r_n" = CLAUDE.md ] && [ -e "$1/AGENTS.md" ] && [ "$_r_f" -ef "$1/AGENTS.md" ] && continue
    if grep -Eiq "(^|$_r_w)(pull requests?|code reviews?|reviewers?|review loops?|before merg(e|ing))($_r_w|\$)" "$_r_f" ||
      grep -Eq "(^|$_r_w)PRs?($_r_w|\$)" "$_r_f"; then
      printf '%s\n' "$_r_n"
    fi
  done
}

# What the repo at $1 declares that the hooks speak on, one per line, as the binary's log line's `found`; nothing when
# switched off. $2 is the harness: `codex` counts its role files too, `opencode` the project's own agents there.
declared_found() {
  switched_off "$1" && return 0
  _r_list "$1/.claude/agents" .md '' .claude/agents
  case $2 in
    codex) _r_list "$1/.codex/agents" .toml '' .codex/agents ;;
    opencode) _r_list "$1/.opencode/agents" .md own .opencode/agents ;;
  esac
  _r_rules "$1"
}

# Whether the hooks speak in the repo at $1 under harness $2.
role_signs() {
  [ -n "$(declared_found "$1" "$2")" ]
}

case ${0##*/} in
  craft-hook-repo.sh)
    _r_root=$(repo_root "${2:-.}")
    case ${1:-} in
      found) declared_found "$_r_root" "${3:-claude-code}" ;;
      speaks) role_signs "$_r_root" "${3:-claude-code}" ;;
      *)
        printf 'usage: craft-hook-repo.sh found|speaks <dir> <harness>\n' >&2
        exit 2
        ;;
    esac
    ;;
esac
