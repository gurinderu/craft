// The scope-check lines of a record naming no commit (integrations/shared/prior-decision-scope.mjs): by the merge
// on the trunk of the pull request of this repository it links (realm @nick/craft, node #682), else by its date
// (realm @nick/craft, node #676). Imported by integrations/shared/prior-decision-scope.mjs.

/** A shell word for `s`, single-quoted. @param {string} s */
export const shellWord = s => `'${s.replace(/'/g, `'\\''`)}'`

// The trunk, as each line resolves it: origin/HEAD when it names a commit, else origin/main, else origin/master;
// the command substitution fails when none does.
const TRUNK = `$(for r in "$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)" origin/main origin/master; do [ -n "$r" ] && git rev-parse -q --verify "$r^{commit}" >/dev/null && echo "$r" && break; done | grep .)`

// The URL prefixes under which origin names a GitHub repository, `.git` after it or not.
const ORIGIN_FORMS = ['https://github.com/', 'git@github.com:', 'ssh://git@github.com/']

/**
 * The command printing the base of the decision date `day` on the trunk `$t`: its tip's last first-parent commit
 * before that day began anywhere (00:00 at +14:00) — empty when the trunk starts after it.
 * @param {string} day @returns {string}
 */
const dateBase = day => `git rev-list -1 --first-parent ${shellWord(`--before=${day} 00:00:00 +1400`)} "$t" 2>/dev/null`

/** The test that the decision date `day` is later than today in UTC. @param {string} day @returns {string} */
const future = day => `[ ${shellWord(day.replace(/-/g, ''))} -gt "$(date -u +%F | tr -d -)" ]`

/**
 * The line of a decision naming no commit but a date: compared against the trunk's last commit before that day.
 * @param {import('./prior-decisions.mjs').PriorDecision} d @param {string} day @returns {string}
 */
export function datedLine(d, day) {
  const id = shellWord(d.id)
  return (
    `if ${future(day)}; then echo ${id} future; ` +
    `elif ! t=${TRUNK}; then echo ${id} no-trunk; ` +
    `elif ! b=$(${dateBase(day)}); then echo ${id} unreadable; ` +
    `elif [ -n "$b" ]; then git diff --quiet "$b" -- ${shellWord(d.scope)}; echo ${id} $?; else echo ${id} missing; fi`
  )
}

/**
 * The comparison against the merge `$m` of pull request `$n` on the trunk `$t`: the status of `git diff --quiet`
 * against it, then `merge <n>`. The scope unchanged since the merge must also be unchanged on the trunk outside the
 * pull request before it, else the line prints status 1 and `merge <n> between`: from the merge's second parent `p`
 * (its parents read by `git rev-parse "$m^@"`, git failing counting as a change; a squash or a rebase merge has
 * none) and, with a date, from its base `b`, each to the merge's first parent — diffed from their merge-base, so
 * from `p` only the trunk's changes the branch lacked count, and nothing when `b` is the merge or after it. A date
 * later than today leaves the merge alone; one the trunk has no commit before prints `missing`, and git failing to
 * list the trunk before it `unreadable`, as the date's line does.
 * @param {import('./prior-decisions.mjs').PriorDecision} d @param {string} day @returns {string}
 */
function sinceMerge(d, day) {
  const [id, scope] = [shellWord(d.id), shellWord(d.scope)]
  const branch = `p=$(git rev-parse "$m^@" 2>/dev/null) && p=$(printf '%s\\n' "$p" | sed -n 2p) && { [ -z "$p" ] || git diff --quiet "$p...$m^1" -- ${scope}; }`
  /** @type {Array<[string, string]>} */
  const dated = day
    ? [
        [`! ${future(day)} && ! b=$(${dateBase(day)})`, 'unreadable'],
        [`! ${future(day)} && [ -z "$b" ]`, 'missing'],
      ]
    : []
  /** @type {Array<[string, string]>} */
  const window = day ? [[`[ -n "$b" ] && ! git diff --quiet "$b...$m^1" -- ${scope}`, '1 merge "$n" between']] : []
  /** @type {Array<[string, string]>} */
  const clauses = [...dated, [`! git diff --quiet "$m" -- ${scope}`, '1 merge "$n"'], [`! { ${branch}; }`, '1 merge "$n" between'], ...window]
  const tests = clauses.map(([test, said], i) => `${i ? 'elif' : 'if'} ${test}; then echo ${id} ${said}; `).join('')
  return `b=; ${tests}else echo ${id} 0 merge "$n"; fi`
}

/**
 * The line of a decision naming no commit but pull requests (realm @nick/craft, node #682): `n` is the number of
 * the first whose repository origin names, lower-cased, credentials before an `@` in an https host and one
 * trailing `/` dropped (an ssh host alias or www.github.com names none); its merge `m` on the trunk tip's
 * first-parent line the newest commit whose subject is GitHub's `Merge pull request #<n> from …`, else the oldest
 * whose subject ends `(#<n>)` — the squash itself, not a later commit citing the request. Found, the scope is
 * compared against it (sinceMerge); not, the date's line runs, or with no date the line prints `unmerged`.
 * @param {import('./prior-decisions.mjs').PriorDecision} d @param {import('./prior-decision-record.mjs').Pull[]} pulls @param {string} day @returns {string}
 */
export function mergeLine(d, pulls, day) {
  /** @param {import('./prior-decision-record.mjs').Pull} p */
  const forms = p => ORIGIN_FORMS.flatMap(f => [`${f}${shellWord(p.repo)}`, `${f}${shellWord(p.repo)}.git`]).join('|')
  const pick = pulls.map(p => `${forms(p)}) n=${String(p.number)};;`).join(' ')
  const pickMerge =
    `'{ s = substr($0, index($0, " ") + 1) } m == "" && index(s, "Merge pull request #" n " from ") == 1 { m = $1; next } ` +
    `s ~ ("\\\\(#" n "\\\\)$") { q = $1 } END { print (m != "" ? m : q) }'`
  const log = `git log --first-parent --no-show-signature --format='%H %s' "$t" 2>/dev/null | awk -v n="$n" ${pickMerge}`
  const origin = `git remote get-url origin 2>/dev/null | tr '[:upper:]' '[:lower:]' | sed -e 's#^https://[^/]*@#https://#' -e 's#/$##'`
  return (
    `u=$(${origin}); case "$u" in ${pick} *) n=;; esac; ` +
    `if [ -n "$n" ] && t=${TRUNK} && m=$(${log}) && [ -n "$m" ]; then ${sinceMerge(d, day)}; ` +
    `else ${day ? datedLine(d, day) : `echo ${shellWord(d.id)} unmerged`}; fi`
  )
}
