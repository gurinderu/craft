#!/bin/sh
# The one download of the craft binary into ~/.craft/bin/<version>/craft (realm @nick/craft, nodes #500, #550): the
# release's craft-<target>.tar.gz and its .sha256 (GitHub release v<version>, or CRAFT_RELEASE_BASE), the SHA-256
# checked, the binary unpacked into place. bin/craft sources it before it runs the binary; lib/craft-hook.sh runs it
# in the background when a hook finds the binary absent, since the Claude Code delivery has no bin/. The cache and its
# layout are lib/craft-bin.mjs's, so every delivery shares one copy. Windows is not covered: it has no sh.
#
#   sh lib/craft-fetch.sh <version> [--background]
#
# A lock directory beside the binary (<dir>/.lock) keeps two sessions from downloading at once: a second caller waits
# for the first (up to 5 minutes), or with --background leaves at once; a lock older than 10 minutes is a dead
# holder's and is taken over. A failure prints one line on stderr naming what is missing, and exits 127.

# Fetch the binary of version $1 unless it is there; $2 `--background` leaves when another holds the lock.
craft_fetch() {
  _cf_version=$1
  _cf_mode=${2:-}
  [ -n "${HOME:-}" ] || _cf_die "HOME is not set: no place for ~/.craft/bin/$_cf_version"
  _cf_dir=$HOME/.craft/bin/$_cf_version
  _cf_bin=$_cf_dir/craft
  [ -f "$_cf_bin" ] && [ -x "$_cf_bin" ] && return 0
  case "$(uname -s)/$(uname -m)" in
    Linux/x86_64 | Linux/amd64) _cf_target=x86_64-unknown-linux-musl ;;
    Linux/aarch64 | Linux/arm64) _cf_target=aarch64-unknown-linux-musl ;;
    Darwin/x86_64) _cf_target=x86_64-apple-darwin ;;
    Darwin/arm64 | Darwin/aarch64) _cf_target=aarch64-apple-darwin ;;
    *) _cf_die "no released craft binary for $(uname -s)/$(uname -m): build it from cli/ and set CRAFT_BIN" ;;
  esac
  if command -v curl >/dev/null 2>&1; then
    _cf_get() { curl -fsL --retry 2 -o "$2" "$1"; }
  elif command -v wget >/dev/null 2>&1; then
    _cf_get() { wget -q -O "$2" "$1"; }
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
  mkdir -p "$_cf_dir" || _cf_die "cannot create $_cf_dir"
  _cf_lock "$_cf_mode" || return 0
  # The holder before us may have installed it.
  if [ -f "$_cf_bin" ] && [ -x "$_cf_bin" ]; then
    _cf_unlock
    return 0
  fi
  _cf_install
  _cf_unlock
}

_cf_die() {
  printf 'craft: %s\n' "$1" >&2
  exit 127
}

# Take <dir>/.lock; 1 when --background and another holds it (or a waiter saw the binary appear).
_cf_lock() {
  _cf_waited=0
  until mkdir "$_cf_dir/.lock" 2>/dev/null; do
    if [ -n "$(find "$_cf_dir/.lock" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then
      rmdir "$_cf_dir/.lock" 2>/dev/null
      continue
    fi
    [ "$1" = --background ] && return 1
    [ -f "$_cf_bin" ] && [ -x "$_cf_bin" ] && return 1
    [ "$_cf_waited" -lt 300 ] || _cf_die "another download of the craft binary $_cf_version holds $_cf_dir/.lock"
    sleep 1
    _cf_waited=$((_cf_waited + 1))
  done
  return 0
}

_cf_unlock() {
  rmdir "$_cf_dir/.lock" 2>/dev/null
  return 0
}

_cf_fail() {
  rm -rf "$_cf_tmp"
  _cf_unlock
  _cf_die "$1"
}

_cf_install() {
  _cf_asset=craft-$_cf_target.tar.gz
  _cf_base=${CRAFT_RELEASE_BASE:-https://github.com/gurinderu/craft/releases/download/v$_cf_version}
  _cf_tmp=$(mktemp -d "$_cf_dir/.fetch-XXXXXX") || _cf_fail "cannot create a temporary directory in $_cf_dir"
  _cf_get "$_cf_base/$_cf_asset" "$_cf_tmp/$_cf_asset" || _cf_fail "could not download $_cf_base/$_cf_asset"
  _cf_get "$_cf_base/$_cf_asset.sha256" "$_cf_tmp/$_cf_asset.sha256" || _cf_fail "could not download $_cf_base/$_cf_asset.sha256"
  _cf_expected=$(sed -n '1s/^\([0-9a-fA-F]\{64\}\).*/\1/p' "$_cf_tmp/$_cf_asset.sha256" | tr 'A-F' 'a-f')
  [ -n "$_cf_expected" ] || _cf_fail "$_cf_asset.sha256 holds no SHA-256"
  _cf_actual=$(_cf_digest "$_cf_tmp/$_cf_asset" | cut -d' ' -f1)
  [ "$_cf_actual" = "$_cf_expected" ] || _cf_fail "$_cf_asset: SHA-256 $_cf_actual is not the published $_cf_expected"
  tar -xzf "$_cf_tmp/$_cf_asset" -C "$_cf_tmp" craft 2>/dev/null || _cf_fail "could not unpack craft from $_cf_asset"
  [ -f "$_cf_tmp/craft" ] && [ ! -L "$_cf_tmp/craft" ] || _cf_fail "craft in $_cf_asset is not a regular file"
  chmod 755 "$_cf_tmp/craft" && mv -f "$_cf_tmp/craft" "$_cf_bin" || _cf_fail "could not install $_cf_bin"
  rm -rf "$_cf_tmp"
}

# Run as a script (not sourced): fetch the version it is given.
case ${0##*/} in
  craft-fetch.sh)
    [ -n "${1:-}" ] || _cf_die "usage: craft-fetch.sh <version> [--background]"
    craft_fetch "$1" "${2:-}"
    ;;
esac
