#!/bin/sh
# The one download of the craft binary into ~/.craft/bin/<version>/craft (realm @nick/craft, nodes #457, #500, #550):
# the release's craft-<target>.tar.gz and its .sha256, the SHA-256 checked, the binary unpacked into place. bin/craft
# sources it before it runs the binary; lib/craft-hook.sh runs it in the background when a hook finds the binary absent
# (the Claude Code delivery has no bin/); lib/craft-bin.mjs ensure, the review engine's fetcher, runs it everywhere sh
# runs — on Windows, where it does not, that file keeps its own Node download. The cache layout is lib/craft-bin.mjs's.
#
#   sh lib/craft-fetch.sh <version> [--background | --failure]
#
#   CRAFT_RELEASE_BASE  the download directory (default https://github.com/<repo>/releases/download/v<version>)
#   CRAFT_REPO          owner/name of the release (default gurinderu/craft)
#   CRAFT_API_BASE      the REST API (default https://api.github.com)
#   CRAFT_TARGET        the release target (default: this machine's, by uname)
#   GITHUB_TOKEN, GH_TOKEN  a bearer for the API only
#
# With curl, a download URL failing transiently (a 5xx, a 429, a network error or timeout) is tried once more through
# the REST release assets (#457): the release read once, each asset by its API URL, the token and the API version header
# sent to the API's origin only, a 401 or 403 to the token asked once more without it. wget has no such fallback.
# A lock directory beside the binary (<dir>/.lock, its owner's token inside) keeps two sessions from downloading at
# once: a second caller waits for the first (up to 5 minutes), or with --background leaves at once; a lock older than 10
# minutes is a dead holder's and is taken over, and a holder removes the lock only while it is still its own. A
# signal or a failure removes the partial fetch and the lock. A failure prints one line on stderr naming what is
# missing, and exits 127.
#
# --background is the try every caller in the background makes (the start hook, OpenCode's work hook through
# bin/craft --ensure --background): at most once an hour, its output in ~/.craft/bin/<version>.log (cut back past
# 64 KiB), how it ended in <version>.status. --failure prints the line that says a failed try, once per failing
# streak: <version>.told stays across the retries until a try succeeds; a new version has its own.

# Fetch the binary of version $1 unless it is there; $2 `--background` leaves when another holds the lock.
craft_fetch() {
  _cf_version=$1
  _cf_mode=${2:-}
  _cf_tmp=''
  _cf_token=''
  [ -n "${HOME:-}" ] || _cf_die "HOME is not set: no place for ~/.craft/bin/$_cf_version"
  _cf_dir=$HOME/.craft/bin/$_cf_version
  _cf_bin=$_cf_dir/craft
  [ -f "$_cf_bin" ] && [ -x "$_cf_bin" ] && return 0
  _cf_target=${CRAFT_TARGET:-$(_cf_target)} || exit 127
  _cf_tools
  mkdir -p "$_cf_dir" || _cf_die "cannot create $_cf_dir"
  _cf_lock "$_cf_mode" || return 0
  # A background try counts from the moment it holds the lock: one that left for another holder is not one.
  [ "$_cf_mode" != --background ] || : >"$(_cf_state "$_cf_version" attempt)"
  trap '_cf_cleanup; exit 130' INT TERM HUP
  # The holder before us may have installed it.
  if ! { [ -f "$_cf_bin" ] && [ -x "$_cf_bin" ]; }; then
    _cf_install
  fi
  _cf_cleanup
  trap - INT TERM HUP
}

# The state of version $1's download beside its directory: ~/.craft/bin/<version>.$2.
_cf_state() {
  printf '%s/.craft/bin/%s.%s' "$HOME" "$1" "$2"
}

# 0 when no try of version $1 began within the hour.
craft_fetch_due() {
  [ -z "$(find "$(_cf_state "$1" attempt)" -mmin -60 2>/dev/null)" ]
}

# 0 while version $1 is in a failing streak that was already said.
craft_fetch_failing() {
  [ -e "$(_cf_state "$1" told)" ]
}

# The background try of version $1: at most once an hour, logged, its end kept; a success ends the streak.
craft_fetch_background() {
  [ -n "${HOME:-}" ] || return 0
  craft_fetch_due "$1" || return 0
  mkdir -p "$HOME/.craft/bin" 2>/dev/null || return 0
  _cf_log=$(_cf_state "$1" log)
  [ ! -f "$_cf_log" ] || [ "$(wc -c <"$_cf_log")" -le 65536 ] || : >"$_cf_log"
  (craft_fetch "$1" --background) >>"$_cf_log" 2>&1 </dev/null
  _cf_rc=$?
  if [ -f "$HOME/.craft/bin/$1/craft" ] && [ -x "$HOME/.craft/bin/$1/craft" ]; then
    echo 0 >"$(_cf_state "$1" status)"
    rm -f "$(_cf_state "$1" told)"
  elif [ "$_cf_rc" -ne 0 ]; then
    echo "$_cf_rc" >"$(_cf_state "$1" status)"
  fi
  return 0
}

# The line that says version $1's last try failed, the first time it is asked in a failing streak; 1 otherwise.
craft_fetch_failure() {
  [ -n "${HOME:-}" ] || return 1
  _cf_status=$(cat "$(_cf_state "$1" status)" 2>/dev/null)
  [ -n "$_cf_status" ] && [ "$_cf_status" != 0 ] && ! craft_fetch_failing "$1" || return 1
  : >"$(_cf_state "$1" told)" 2>/dev/null || return 1
  printf "the craft binary %s could not be downloaded (see ~/.craft/bin/%s.log); craft's hooks stay silent until it is there" "$1" "$1"
}

_cf_die() {
  printf 'craft: %s\n' "$1" >&2
  exit 127
}

_cf_target() {
  case "$(uname -s)/$(uname -m)" in
    Linux/x86_64 | Linux/amd64) printf x86_64-unknown-linux-musl ;;
    Linux/aarch64 | Linux/arm64) printf aarch64-unknown-linux-musl ;;
    Darwin/x86_64) printf x86_64-apple-darwin ;;
    Darwin/arm64 | Darwin/aarch64) printf aarch64-apple-darwin ;;
    *) _cf_die "no released craft binary for $(uname -s)/$(uname -m): build it from cli/ and set CRAFT_BIN" ;;
  esac
}

_cf_tools() {
  if command -v curl >/dev/null 2>&1; then
    _cf_curl=1
  elif command -v wget >/dev/null 2>&1; then
    _cf_curl=''
  else
    _cf_die "neither curl nor wget is on the PATH to download the craft binary $_cf_version"
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    _cf_digest() { sha256sum "$1"; }
  elif command -v shasum >/dev/null 2>&1; then
    _cf_digest() { shasum -a 256 "$1"; }
  else
    _cf_die "neither sha256sum nor shasum is on the PATH to check the craft binary $_cf_version"
  fi
}

# Take <dir>/.lock with a token of our own; 1 when --background and another holds it (or a waiter saw the binary appear).
_cf_lock() {
  _cf_waited=0
  _cf_me="$$-$(date +%s)-${RANDOM:-0}"
  until mkdir "$_cf_dir/.lock" 2>/dev/null; do
    if [ -n "$(find "$_cf_dir/.lock" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then
      rm -rf "$_cf_dir/.lock"
      continue
    fi
    [ "$1" = --background ] && return 1
    [ -f "$_cf_bin" ] && [ -x "$_cf_bin" ] && return 1
    [ "$_cf_waited" -lt 300 ] || _cf_die "another download of the craft binary $_cf_version holds $_cf_dir/.lock"
    sleep 1
    _cf_waited=$((_cf_waited + 1))
  done
  printf '%s\n' "$_cf_me" >"$_cf_dir/.lock/owner"
  _cf_token=$_cf_me
  return 0
}

# Remove the lock only while it is still ours: a holder taken over as stale must not remove its successor's.
_cf_unlock() {
  [ -n "$_cf_token" ] || return 0
  if [ "$(cat "$_cf_dir/.lock/owner" 2>/dev/null)" = "$_cf_token" ]; then
    rm -rf "$_cf_dir/.lock"
  fi
  _cf_token=''
  return 0
}

_cf_cleanup() {
  [ -z "$_cf_tmp" ] || rm -rf "$_cf_tmp"
  _cf_tmp=''
  _cf_unlock
}

_cf_fail() {
  _cf_cleanup
  _cf_die "$1"
}

# The HTTP side, beside this file: from bin/craft ($0 is bin/craft) and run as lib/craft-fetch.sh alike.
. "$(dirname "$0")/../lib/craft-fetch-http.sh" || _cf_die "cannot read $(dirname "$0")/../lib/craft-fetch-http.sh"

_cf_install() {
  _cf_repo=${CRAFT_REPO:-gurinderu/craft}
  _cf_asset=craft-$_cf_target.tar.gz
  _cf_base=${CRAFT_RELEASE_BASE:-https://github.com/$_cf_repo/releases/download/v$_cf_version}
  _cf_tmp=$(mktemp -d "$_cf_dir/.fetch-XXXXXX") || _cf_fail "cannot create a temporary directory in $_cf_dir"
  _cf_asset_get "$_cf_asset" "$_cf_tmp/$_cf_asset"
  _cf_asset_get "$_cf_asset.sha256" "$_cf_tmp/$_cf_asset.sha256"
  _cf_expected=$(sed -n '1s/^\([0-9a-fA-F]\{64\}\).*/\1/p' "$_cf_tmp/$_cf_asset.sha256" | tr 'A-F' 'a-f')
  [ -n "$_cf_expected" ] || _cf_fail "$_cf_asset.sha256 holds no SHA-256"
  _cf_actual=$(_cf_digest "$_cf_tmp/$_cf_asset" | cut -d' ' -f1)
  [ "$_cf_actual" = "$_cf_expected" ] || _cf_fail "$_cf_asset: SHA-256 $_cf_actual is not the published $_cf_expected"
  tar -xzf "$_cf_tmp/$_cf_asset" -C "$_cf_tmp" craft 2>/dev/null || _cf_fail "could not unpack craft from $_cf_asset"
  [ -f "$_cf_tmp/craft" ] && [ ! -L "$_cf_tmp/craft" ] || _cf_fail "craft in $_cf_asset is not a regular file"
  chmod 755 "$_cf_tmp/craft" && mv -f "$_cf_tmp/craft" "$_cf_bin" || _cf_fail "could not install $_cf_bin"
}

# Run as a script (not sourced): fetch the version it is given.
case ${0##*/} in
  craft-fetch.sh)
    [ -n "${1:-}" ] || _cf_die "usage: craft-fetch.sh <version> [--background | --failure]"
    case ${2:-} in
      --background) craft_fetch_background "$1" ;;
      --failure) craft_fetch_failure "$1" || : ;;
      *) craft_fetch "$1" ;;
    esac
    ;;
esac
