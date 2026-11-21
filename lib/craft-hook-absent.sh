# What lib/craft-hook.sh does while the craft binary is absent (realm @nick/craft, node #550). Sourced; it reads
# `hook`, `version`, `here`, `bin`, `field`, `esc` and lib/craft-hook-repo.sh's functions.

# How long `codex sandbox true` may take before the check gives up and says nothing, in tenths of a second.
SANDBOX_TENTHS=30

# The state of this version's download under ~/.craft/bin: its log, when it was last tried, how it ended, whether
# its failure was said.
state() {
  printf '%s/.craft/bin/%s.%s' "$HOME" "$version" "$1"
}

# Run $@ in a session of its own where setsid exists (Linux); macOS has none, and there it runs under nohup in the
# hook's process group: an accepted limit (realm @nick/craft, node #550).
detached() {
  if command -v setsid >/dev/null 2>&1; then setsid "$@"; else nohup "$@"; fi
}

# Start the download of this version in the background, its output in ~/.craft/bin/<version>.log (cut back past
# 64 KiB), its end in <version>.status: the hook returns at once and a later session finds the binary.
# lib/craft-fetch.sh's lock keeps a second one from starting.
fetch_in_background() {
  mkdir -p "$HOME/.craft/bin" 2>/dev/null || return 0
  _a_log=$(state log)
  [ ! -f "$_a_log" ] || [ "$(wc -c <"$_a_log")" -le 65536 ] || : >"$_a_log"
  : >"$(state attempt)"
  rm -f "$(state status)" "$(state told)"
  detached sh -c 'sh "$1" "$2" --background; echo $? >"$3"' sh "$here/lib/craft-fetch.sh" "$version" "$(state status)" \
    </dev/null >>"$_a_log" 2>&1 &
}

# What the start says of the download: it starts one unless one was tried within the hour; a failed one is said once
# (realm @nick/craft, node #550). Empty for silence.
download_said() {
  if [ -n "$(find "$(state attempt)" -mmin -60 2>/dev/null)" ]; then
    _a_status=$(cat "$(state status)" 2>/dev/null)
    if [ -n "$_a_status" ] && [ "$_a_status" != 0 ] && [ ! -e "$(state told)" ]; then
      : >"$(state told)"
      printf "the craft binary %s could not be downloaded (see ~/.craft/bin/%s.log); craft's hooks stay silent until it is there" "$version" "$version"
    fi
    return 0
  fi
  fetch_in_background
  printf "the craft binary %s is not on this machine yet (%s); it is being downloaded in the background (~/.craft/bin/%s.log), and craft's hooks speak once it is there" "$version" "$bin" "$version"
}

# The line to tell the user when Codex's sandbox cannot be set up to run `true`; '' when it can, when `codex` cannot
# start, when the probe outlives its bound, or when it failed without a sandbox-setup error.
sandbox_line() {
  command -v codex >/dev/null 2>&1 || return 0
  _a_err=$(mktemp) || return 0
  if command -v setsid >/dev/null 2>&1; then
    setsid codex sandbox true </dev/null >/dev/null 2>"$_a_err" &
  else
    codex sandbox true </dev/null >/dev/null 2>"$_a_err" &
  fi
  _a_pid=$!
  _a_n=0
  while kill -0 "$_a_pid" 2>/dev/null; do
    if [ "$_a_n" -ge "$SANDBOX_TENTHS" ]; then
      # Its whole session where it has one, so what it started goes too.
      kill -TERM "-$_a_pid" 2>/dev/null || kill "$_a_pid" 2>/dev/null
      rm -f "$_a_err"
      return 0
    fi
    sleep 0.1
    _a_n=$((_a_n + 1))
  done
  wait "$_a_pid"
  _a_status=$?
  if [ "$_a_status" -eq 0 ] || [ "$_a_status" -gt 128 ] ||
    ! grep -Eiq '(^|[^A-Za-z0-9_])bwrap:|operation not permitted|(^|[^A-Za-z0-9_])unshare([^A-Za-z0-9_]|$)|user namespace|uid_map' "$_a_err"; then
    rm -f "$_a_err"
    return 0
  fi
  # Codex may print its own WARNING lines before the sandbox's error: the first other line is the error.
  _a_lines=$(sed 's/^[[:space:]]*//;s/[[:space:]]*$//' "$_a_err" | grep -v '^$')
  rm -f "$_a_err"
  _a_said=$(printf '%s\n' "$_a_lines" | grep -v '^WARNING:' | head -n 1)
  [ -n "$_a_said" ] || _a_said=$(printf '%s\n' "$_a_lines" | head -n 1)
  [ -z "$_a_said" ] || _a_said=": $_a_said"
  printf "craft: before any work, tell the user that Codex's sandbox cannot run commands on this machine (\`codex sandbox true\` exited %s%s). So craft's review and its review agents (\`codex exec -s read-only\`) will fail here. The fix is to allow unprivileged user namespaces for bwrap (on Ubuntu: the sysctl kernel.apparmor_restrict_unprivileged_userns, or an AppArmor profile for bwrap), or to run the review from another host." "$_a_status" "$_a_said"
}

# The harness: Codex by its PLUGIN_ROOT or the input's turn_id, Claude Code otherwise.
harness() {
  if [ -n "${PLUGIN_ROOT:-}" ] || [ -n "$(field turn_id)" ]; then printf codex; else printf claude-code; fi
}

absent() {
  _a_cwd=$(field cwd)
  _a_root=$(repo_root "${_a_cwd:-$PWD}")
  switched_off "$_a_root" && return 0
  _a_who=$(harness)
  _a_said=''
  if role_signs "$_a_root" "$_a_who"; then
    _a_said="the craft binary $version is not on this machine yet ($bin)"
    [ "$hook" != session-start ] || [ -n "${CRAFT_BIN:-}" ] || _a_said=$(download_said)
  fi
  if [ "$hook" != session-start ]; then
    [ -z "$_a_said" ] || printf 'craft: the %s hook did not run: %s.\n' "$hook" "$_a_said" >&2
    return 0
  fi
  _a_context=''
  [ "$_a_who" != codex ] || _a_context=$(sandbox_line)
  [ -n "$_a_said$_a_context" ] || return 0
  _a_out=''
  [ -z "$_a_said" ] || _a_out="\"systemMessage\":\"craft: the session-start hook did not run: $(esc "$_a_said").\""
  if [ -n "$_a_context" ]; then
    [ -z "$_a_out" ] || _a_out="$_a_out,"
    _a_out="$_a_out\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"$(esc "$_a_context")\"}"
  fi
  printf '{%s}\n' "$_a_out"
}
