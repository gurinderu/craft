// The shell an agent runs a plugin script through: a value single-quoted for it (shq), and the plugin script
// located without ever trusting the reviewed repository (pluginScriptPrelude). Kept out of lib/run-logging.mjs,
// which re-exports both, because importing that module is what makes an engine a record filer
// (lib/engine-harness.mjs, recordFilingEngines): cli-review locates lib/craft-bin.mjs this way and files no record.

// POSIX single-quote shell-escaper for a model-authored value that lands in a shell command a
// sub-agent will RUN (the logger's `cd <repo>`, review.js's carry/adjudicate `git diff -- <path>`).
// Single quotes disable ALL shell expansion, so `$(...)`, backtick, `$VAR`, spaces and `;`/`|`/`&`
// inside are literal. The `'\''` sequence (close-quote, escaped-quote, reopen-quote) safely embeds
// a literal single quote. Note: JSON.stringify does NOT make a value shell-safe — it only escapes
// `"`/`\`/control chars, and inside a double-quoted shell context `$(...)`, backtick and `$VAR` still
// expand; single-quoting is what neutralizes them.
/** @param {unknown} s */
export function shq(s) { return `'${String(s ?? '').replace(/'/g, `'\\''`)}'` }

/**
 * The shell that sets `varName` to the resolved absolute path of `script` (a path inside the plugin), or leaves
 * it empty when no candidate qualifies — the caller decides what an empty one means: the logger refuses
 * (loggerPrelude), the units probe falls back to its prose commands (lib/rust-units.mjs). Every plugin script
 * an agent RUNS is located this way, never by a bare candidate list (the reasons in the body below).
 * @param {string | undefined} craftRoot @param {string} version @param {string} repo
 * @param {string} script  a path inside the plugin, shell-inert (a constant of the caller's)
 * @param {string} varName  a shell variable name
 */
export function pluginScriptPrelude(craftRoot, version, repo, script, varName) {
  // ONE pipeline for every way the logger can be located, and that uniformity is the fix rather than
  // a tidy-up. Each source used to get its own treatment: an explicit `craftRoot` returned EARLY,
  // before the absoluteness check and before the refusal, so a review launched with `craftRoot=.`
  // emitted `CRAFT_LOGGER='.'/lib/<the logger script>` and then `cd <reviewed repo> && node
  // "$CRAFT_LOGGER"` — the removed `:-.` hole restored verbatim, bypassing the version pin and the
  // loud refusal too. `craftRoot` arrives in the model-composed args string, so it is exactly as
  // untrusted as the `--dir` this project already refuses.
  //
  // Three properties now hold for every candidate without exception:
  //   ABSOLUTE — `[ -f ]` is evaluated in the logger agent's cwd while `node` runs AFTER the cd into
  //     the reviewed repository, so any relative path resolves THERE. Refused outright rather than
  //     normalized: guessing what the caller meant is how this class keeps coming back.
  //   PRESENT — a path that names no file is not a logger.
  //   ORDERED — explicit root, then the environment, then this engine's own installed copy. The
  //     search is a fallback, never an override: written the other way round it overwrote a good
  //     path with whatever the cache held, so a launch from a checkout logged through another build.
  //
  // The search is version-pinned to what this engine is stamped with (a record filed by another
  // build's script misdescribes which engine ran, and gets counted), looks only under the user's own
  // plugin cache, honours $CLAUDE_CONFIG_DIR because a session configured that way keeps its plugins
  // elsewhere, and never looks at the reviewed repository at all. That cache layout belongs to the
  // harness, not to craft (realm @nick/craft, node #48 — observed, not documented), so a miss is
  // ordinary: not found means the refusal below, never a guess.
  // ONE predicate, applied to every candidate, and applied BEFORE it is accepted rather than to the
  // winner afterwards. Written as a terminal check on the winner, an explicit craftRoot naming the
  // repo killed the whole command instead of being rejected in favour of the next candidate — which
  // is craft reviewing its own checkout, the mode this repo mandates for itself.
  //
  // A candidate qualifies only if it is ABSOLUTE (`[ -f ]` runs in the agent's cwd while `node` runs
  // after the cd, so a relative path resolves in the reviewed repository), PRESENT, and OUTSIDE the
  // directory the command is about to cd into. The last is checked on the FULLY resolved path:
  // symlinks are followed to their target — a link whose FILE points into the repo passed for one
  // commit because only the directory went through `pwd -P` — and both sides are normalized, so a
  // `..` climb and a symlinked parent collapse to the same comparison. The `case` patterns are
  // quoted and slash-anchored, so a sibling that merely shares a prefix (`/x/repo-evil` beside
  // `/x/repo`) is NOT inside — the collision this project already met once in `insideStore`.
  // EVERY exit from this predicate that is not a clean, fully resolved, outside-the-repo path is a
  // REFUSAL. Three of them used to fall through to acceptance, and one was reachable: exhausting the
  // hop bound left the loop with the path still a symlink, the comparison then tested an unresolved
  // string, nothing matched, and the candidate was accepted — a 21-link chain ending inside the
  // reviewed repository executed its script. A bound that fails open is not a bound; it is a longer
  // attack.
  //
  // Two of the three refusals are belt-and-braces and are labelled as such rather than dressed up as
  // covered: with `CRAFT_REPO` empty the `case` pattern degenerates to `/*`, which matches every
  // absolute path and refuses anyway; and `pwd -P` can only fail on a directory with no `x` bit,
  // where `[ -f ]` has already failed one line earlier. Removing either guard changes no observable
  // behaviour, so no test distinguishes them — stated here instead of implied by a test that would
  // pass either way.
  const preamble = `CRAFT_REPO="$(cd ${shq(repo || '.')} 2>/dev/null && pwd -P)" || CRAFT_REPO=""
craft_usable() {
  CRAFT_WHY="not absolute ($1)"
  case "$1" in /*) ;; *) return 1 ;; esac
  CRAFT_WHY="no file at $1"
  [ -f "$1" ] || return 1
  CRAFT_WHY="the reviewed repo "${shq(repo || '.')}" did not resolve (CRAFT_REPO empty)"
  [ -n "$CRAFT_REPO" ] || return 1   # belt to the braces below; see the note in the comment above
  # A repo of "/" contains everything, so nothing can be outside it. The pattern below cannot say
  # that: "$CRAFT_REPO"/* becomes //* and matches no ordinary path, so every candidate reads as
  # outside and the guard inverts into an allow-all. Degenerate input, but the whole point of this
  # predicate is that it fails closed.
  CRAFT_WHY="the reviewed repo is /"
  [ "$CRAFT_REPO" = "/" ] && return 1
  CRAFT_REAL="$1"
  CRAFT_HOPS=0
  CRAFT_WHY="a symlink chain over 16 hops"
  while [ -L "$CRAFT_REAL" ]; do
    [ "$CRAFT_HOPS" -lt 16 ] || return 1
    CRAFT_LINK="$(readlink "$CRAFT_REAL")"
    case "$CRAFT_LINK" in
      /*) CRAFT_REAL="$CRAFT_LINK" ;;
      *) CRAFT_REAL="$(dirname "$CRAFT_REAL")/$CRAFT_LINK" ;;
    esac
    CRAFT_HOPS=$((CRAFT_HOPS + 1))
  done
  CRAFT_WHY="its directory did not resolve"
  CRAFT_DIR="$(cd "$(dirname "$CRAFT_REAL")" 2>/dev/null && pwd -P)" || return 1
  [ -n "$CRAFT_DIR" ] || return 1
  CRAFT_REAL="$CRAFT_DIR/$(basename "$CRAFT_REAL")"
  CRAFT_WHY="inside the reviewed repo ($CRAFT_REAL in $CRAFT_REPO)"
  case "$CRAFT_REAL" in
    "$CRAFT_REPO"/*|"$CRAFT_REPO") return 1 ;;
  esac
  CRAFT_WHY=""
  return 0
}
${varName}=""
${varName}_WHY=""
`
  // The RESOLVED path is what gets used, not the candidate string that was validated. Between the
  // check and `node "$CRAFT_LOGGER"` sit the mktemp, the whole heredoc of a record that can be
  // hundreds of kilobytes, and the cd — a window in which a symlink component of the unresolved
  // candidate can be re-pointed into the reviewed repository. Handing over the path that was
  // actually checked closes that window and costs nothing.
  // Each rejection appends `<source>: <the check that failed>; ` to ${varName}_WHY, in candidate order, so a
  // caller that refuses can say why (realm @nick/craft, node #382). A source with nothing to try says so too.
  /** @param {string} label @param {string} why */
  const noteWhy = (label, why) => `${varName}_WHY="\${${varName}_WHY}"${shq(label)}": ${why}; "\n`
  /** @param {string} label @param {string} expr */
  const tryCandidate = (label, expr) => `if [ -z "\${${varName}:-}" ]; then
  CRAFT_TRY=${expr}
  if craft_usable "$CRAFT_TRY"; then ${varName}="$CRAFT_REAL"; else ${noteWhy(label, '$CRAFT_WHY').trimEnd()}; fi
fi
`
  const explicit = craftRoot ? tryCandidate('craftRoot', `${shq(craftRoot)}"/${script}"`) : noteWhy('craftRoot', 'not passed')
  // An unset or empty CLAUDE_PLUGIN_ROOT is reported as such and not tried: tried, it was the path `/<script>`.
  const fromEnv = `if [ -z "\${CLAUDE_PLUGIN_ROOT:-}" ]; then ${noteWhy('CLAUDE_PLUGIN_ROOT', 'unset').trimEnd()}; else
${tryCandidate('CLAUDE_PLUGIN_ROOT', `"\${CLAUDE_PLUGIN_ROOT:-}/${script}"`)}fi
`
  const installed = version
    ? tryCandidate(`installed copy ${version}`, `"\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/craft/craft/"${shq(version)}"/${script}"`)
    : noteWhy('installed copy', 'no version to look up')
  return `${preamble}${explicit}${fromEnv}${installed}`
}
