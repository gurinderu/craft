// The reviewed repository's own rule files (realm @nick/craft, nodes #406, #410): the scout locates them and
// returns their paths, never their contents; every lens is told to grep them and open only the sections
// that bear on what it reviews, so a violation it reports can cite the rule as `repoRule` and carry the
// `repo-rule` harm (lib/harm-repo-rule.mjs, node #379). Never read whole: a lens re-reads its context on
// every tick, and a rule file can run to tens of KB.

/** At most this many rule files reach a lens prompt. */
export const REPO_RULES_MAX = 5
/** And at most this many characters of their joined paths: the line's length is bounded, not only its count. */
export const REPO_RULES_MAX_CHARS = 120

// A path the prompt can carry verbatim: repo-relative, a plain file-name alphabet, no `..` step. The
// path is the reviewed repository's, model-relayed — anything else is dropped, not escaped.
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\w.\-/]{1,100}$/

/**
 * The scout's rule-file paths as the engine keeps them: strings of the safe form, trimmed, de-duplicated,
 * in the scout's order, at most REPO_RULES_MAX of them and REPO_RULES_MAX_CHARS of path text (one that
 * would pass it is skipped). Anything that is not an array reads as none.
 * @param {unknown} raw
 * @returns {string[]}
 */
export function repoRulePaths(raw) {
  if (!Array.isArray(raw)) return []
  /** @type {string[]} */
  const out = []
  let chars = 0
  for (const p of raw) {
    const s = typeof p === 'string' ? p.trim().replace(/^\.\//, '') : ''
    if (!SAFE_PATH.test(s) || out.includes(s) || chars + s.length > REPO_RULES_MAX_CHARS) continue
    out.push(s)
    chars += s.length
    if (out.length === REPO_RULES_MAX) break
  }
  return out
}

/**
 * The paths the run's profiles found, in first-seen order, capped like one profile's.
 * @param {Array<string[] | undefined>} lists
 * @returns {string[]}
 */
export function mergedRepoRules(lists) {
  return repoRulePaths(lists.flatMap(l => l ?? []))
}

/**
 * The one line a lens prompt carries for the repository's rule files, '' when there are none.
 * @param {string[] | undefined} paths
 * @returns {string}
 */
export function repoRulesLine(paths) {
  return paths?.length ? `REPO RULES ${paths.map(p => `\`${p}\``).join(', ')}: grep them for what you review, open only matching sections, never a whole file (no SCOPE rule bars them); a violation cites its rule as \`repoRule\` {file, text}.` : ''
}

/** The scout's step that finds them: names, never contents. */
export const SCOUT_REPO_RULES_STEP = `repoRules: the repository's own rule files at HEAD — AGENTS.md, CLAUDE.md, CONTRIBUTING.md, .github/copilot-instructions.md and the like (\`git ls-files\`: the root, .github/, and the directories of the changed files). Return repo-relative paths, at most ${REPO_RULES_MAX}; do not read them. Empty when there are none.`
