#!/bin/sh
# Shared POSIX entry, also shipped in packages without bin/ (realm @nick/craft, node #500).
# --ensure --print-path returns the executable without running it. Other ensure modes stay silent
# except --failure, which says a failed background try once. Git Bash on Windows caches craft.exe; Windows
# without sh uses craft-bin.mjs.
set -u

version=0.57.0 # x-release-please-version

die() {
  printf 'craft: %s\n' "$1" >&2
  exit 127
}

helpers=$(cd "$(dirname "$0")" && pwd -P) || die "cannot find the helpers beside $0"
here=$(cd "$helpers/../.." && pwd -P) || die "cannot find the plugin root above $0"
CRAFT_ROOT=${CRAFT_ROOT:-$here}
export CRAFT_ROOT
CRAFT_FETCH_HELPERS=$helpers

# A distinct mode leaves the old ensure-only contract intact, including a supplied CRAFT_BIN.
if [ "${1:-}" = --ensure ] && [ "${2:-}" = --print-path ]; then
  if [ -n "${CRAFT_BIN:-}" ]; then
    [ -x "$CRAFT_BIN" ] && [ -f "$CRAFT_BIN" ] || die "CRAFT_BIN=$CRAFT_BIN is not an executable file"
    printf '%s\n' "$CRAFT_BIN"
    exit 0
  fi
  [ -n "${HOME:-}" ] || die "HOME is not set: no place for ~/.craft/bin/$version"
  . "$helpers/craft-fetch.sh" || die "cannot read $helpers/craft-fetch.sh"
  craft_fetch "$version"
  printf '%s\n' "$HOME/.craft/bin/$version/$(craft_bin_name)"
  exit 0
fi

# `--ensure [--background | --failure]`: only make sure the binary of this version is in the cache, and run nothing.
if [ "${1:-}" = --ensure ]; then
  [ -z "${CRAFT_BIN:-}" ] || exit 0
  [ -n "${HOME:-}" ] || die "HOME is not set: no place for ~/.craft/bin/$version"
  . "$helpers/craft-fetch.sh" || die "cannot read $helpers/craft-fetch.sh"
  case ${2:-} in
    --background) craft_fetch_background "$version" ;;
    --failure) craft_fetch_failure "$version" || : ;;
    *) craft_fetch "$version" ;;
  esac
  exit 0
fi
if [ -n "${CRAFT_BIN:-}" ]; then
  [ -x "$CRAFT_BIN" ] && [ -f "$CRAFT_BIN" ] || die "CRAFT_BIN=$CRAFT_BIN is not an executable file"
  exec "$CRAFT_BIN" "$@"
fi

[ -n "${HOME:-}" ] || die "HOME is not set: no place for ~/.craft/bin/$version"
# The download itself is integrations/shared/craft-fetch.sh's, shared with the hooks (realm @nick/craft, node #550).
. "$helpers/craft-fetch.sh" || die "cannot read $helpers/craft-fetch.sh"
bin=$HOME/.craft/bin/$version/$(craft_bin_name)
if [ -f "$bin" ] && [ -x "$bin" ]; then
  exec "$bin" "$@"
fi
craft_fetch "$version"
exec "$bin" "$@"
