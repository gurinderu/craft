# The HTTP side of lib/craft-fetch.sh, sourced by it (realm @nick/craft, nodes #457, #490, #550): one release asset by
# name — its download URL first; with curl, when that fails transiently (a 5xx, a 429, a network error or timeout),
# once more through the REST release assets. It reads _cf_base, _cf_repo, _cf_version, _cf_tmp and _cf_curl, and says
# why it failed in _cf_why.

_cf_api_base=${CRAFT_API_BASE:-https://api.github.com}
# The REST API version these requests are written against, sent to the API's own origin only.
_cf_api_version=2022-11-28
_cf_bearer=${GITHUB_TOKEN:-${GH_TOKEN:-}}

# The origin of a URL: scheme://host[:port].
_cf_origin() {
  printf '%s' "$1" | sed 's#^\([A-Za-z][A-Za-z0-9+.-]*://[^/?#]*\).*#\1#'
}

# $1 to $2 by its download URL, redirects followed; 0, or 1 with _cf_why (2 when another path may succeed).
_cf_download() {
  if [ -z "$_cf_curl" ]; then
    wget -q -T 60 -O "$2" "$1" && return 0
    _cf_why="could not download $1"
    return 1
  fi
  _cf_code=$(curl -sL -o "$2" -w '%{http_code}' --connect-timeout 15 --max-time 300 "$1" 2>/dev/null)
  _cf_rc=$?
  if [ "$_cf_rc" -eq 0 ] && { [ "$_cf_code" = 200 ] || [ "$_cf_code" = 000 ]; }; then return 0; fi
  if [ "$_cf_rc" -eq 0 ]; then
    _cf_why="HTTP $_cf_code for $1"
    case $_cf_code in
      5[0-9][0-9] | 429) return 2 ;;
      *) return 1 ;;
    esac
  fi
  _cf_why="could not download $1"
  case $_cf_rc in
    5 | 6 | 7 | 28 | 35 | 52 | 55 | 56) return 2 ;;
    *) return 1 ;;
  esac
}

# $1 from the API to $2, accepting $3, following redirects by hand: the token ($4, empty for none) and the API version
# go to the API's origin only; 0, or 1 with _cf_why and the last status in _cf_code.
_cf_api_once() {
  _cf_url=$1
  _cf_start=$1
  _cf_dest=$2
  _cf_accept=$3
  _cf_tok=$4
  _cf_hops=0
  _cf_api_origin=$(_cf_origin "$_cf_api_base")
  while :; do
    set -- -H "user-agent: craft-bin" -H "accept: $_cf_accept"
    if [ "$(_cf_origin "$_cf_url")" = "$_cf_api_origin" ]; then
      set -- "$@" -H "x-github-api-version: $_cf_api_version"
      [ -z "$_cf_tok" ] || set -- "$@" -H "authorization: Bearer $_cf_tok"
    fi
    _cf_out=$(curl -s -o "$_cf_dest" -w '%{http_code} %{redirect_url}' --connect-timeout 15 --max-time 300 "$@" "$_cf_url" 2>/dev/null)
    _cf_rc=$?
    _cf_code=${_cf_out%% *}
    _cf_next=${_cf_out#* }
    if [ "$_cf_rc" -ne 0 ]; then
      _cf_why="could not download $_cf_url"
      return 1
    fi
    case $_cf_code in
      200) return 0 ;;
      3??)
        [ -n "$_cf_next" ] && [ "$_cf_hops" -lt 5 ] || {
          _cf_why="more than 5 redirects from $_cf_start"
          return 1
        }
        _cf_hops=$((_cf_hops + 1))
        _cf_url=$_cf_next
        ;;
      *)
        _cf_why="HTTP $_cf_code for $_cf_url"
        return 1
        ;;
    esac
  done
}

# $1 from the API to $2 accepting $3; a 401 or 403 to the token is asked once more without it.
_cf_api() {
  _cf_api_once "$1" "$2" "$3" "$_cf_bearer" && return 0
  [ -n "$_cf_bearer" ] && { [ "$_cf_code" = 401 ] || [ "$_cf_code" = 403 ]; } || return 1
  _cf_with=$_cf_why
  _cf_api_once "$1" "$2" "$3" '' && return 0
  _cf_why="with the token: $_cf_with; without it: $_cf_why"
  return 1
}

# The API URL of the asset named $1 in the release listing $2 (the objects of its `assets` array).
_cf_asset_url() {
  tr -d '\n\r' <"$2" | awk -v want="$1" '
    { s = $0; n = length(s)
      for (i = 1; i <= n; i++) {
        c = substr(s, i, 1)
        if (instr) { if (esc) { buf = buf c; esc = 0 } else if (c == "\\") { esc = 1 } else if (c == "\"") { instr = 0; tok = buf; have = 1 } else buf = buf c; continue }
        if (c == "\"") { instr = 1; buf = ""; continue }
        if (c == ":") { if (have) key = tok; have = 0; continue }
        if (c == "{" || c == "[") { depth++; if (c == "[" && depth == 2) arr = key; if (depth == 3) { name = ""; url = "" } key = ""; have = 0; continue }
        if (c == "," || c == "}" || c == "]") {
          if (have && depth == 3 && key == "name") name = tok
          if (have && depth == 3 && key == "url") url = tok
          have = 0; key = ""
          if (c == "}" && depth == 3 && arr == "assets" && name == want) { print url; exit }
          if (c != ",") depth--
        }
      } }'
}

# The asset $1 through the REST API, to $2: the release read once for all its assets.
_cf_through_api() {
  _cf_tag=$_cf_api_base/repos/$_cf_repo/releases/tags/v$_cf_version
  if [ ! -s "$_cf_tmp/.release.json" ]; then
    _cf_api "$_cf_tag" "$_cf_tmp/.release.json" application/vnd.github+json || {
      rm -f "$_cf_tmp/.release.json"
      return 1
    }
  fi
  _cf_asset_api=$(_cf_asset_url "$1" "$_cf_tmp/.release.json")
  [ -n "$_cf_asset_api" ] || {
    _cf_why="release v$_cf_version of $_cf_repo has no asset $1 ($_cf_tag)"
    return 1
  }
  _cf_api "$_cf_asset_api" "$2" application/octet-stream
}

# The release asset $1 into $2, or the fetch fails naming both paths.
_cf_asset_get() {
  _cf_download "$_cf_base/$1" "$2"
  case $? in
    0) return 0 ;;
    1) _cf_fail "$_cf_why" ;;
  esac
  _cf_first=$_cf_why
  _cf_through_api "$1" "$2" || _cf_fail "$_cf_first; then through the API: $_cf_why"
}
