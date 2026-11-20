# What lib/craft-hook.sh does while the craft binary is absent (realm @nick/craft, node #550). Sourced; it reads
# `hook`, `version`, `here`, `bin`, `field`, `esc` and lib/craft-hook-repo.sh's functions.

# How long `codex sandbox true` may take before the check gives up and says nothing, in tenths of a second.
SANDBOX_TENTHS=30

# Start the download of this version in a session of its own, its output in ~/.craft/bin/<version>.log: the hook
# returns at once and the next session finds the binary. lib/craft-fetch.sh's lock keeps a second one from starting.
fetch_in_background() {
  _a_log=$HOME/.craft/bin/$version.log
  mkdir -p "$HOME/.craft/bin" 2>/dev/null || return 0
  if command -v setsid >/dev/null 2>&1; then
    setsid sh "$here/lib/craft-fetch.sh" "$version" --background </dev/null >>"$_a_log" 2>&1 &
  else
    nohup sh "$here/lib/craft-fetch.sh" "$version" --background </dev/null >>"$_a_log" 2>&1 &
  fi
}

# The line to tell the user when Codex's sandbox cannot be set up to run `true`; '' when it can, when `codex` cannot
# start, when the probe outlives its bound, or when it failed without a sandbox-setup error.
sandbox_line() {
  command -v codex >/dev/null 2>&1 || return 0
  _a_err=$(mktemp) || return 0
  codex sandbox true </dev/null >/dev/null 2>"$_a_err" &
  _a_pid=$!
  _a_n=0
  while kill -0 "$_a_pid" 2>/dev/null; do
    if [ "$_a_n" -ge "$SANDBOX_TENTHS" ]; then
      kill "$_a_pid" 2>/dev/null
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

absent() {
  _a_cwd=$(field cwd)
  _a_root=$(repo_root "${_a_cwd:-$PWD}")
  switched_off "$_a_root" && return 0
  _a_who=$(harness)
  _a_said=''
  if role_signs "$_a_root" "$_a_who"; then
    _a_said="the craft binary $version is not on this machine yet ($bin)"
    if [ "$hook" = session-start ] && [ -z "${CRAFT_BIN:-}" ]; then
      fetch_in_background
      _a_said="$_a_said; it is being downloaded in the background (~/.craft/bin/$version.log), and craft's hooks speak once it is there"
    fi
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
