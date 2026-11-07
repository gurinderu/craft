// The harm cap of skills/review-rules/severity.md, held in code (realm @nick/craft, node #379): a
// finding's severity never exceeds the ceiling of the harm level it names. Applied once, at the end
// of verification (lib/review-verify-pool.mjs), after the deletion/recovery path floor (which runs
// before verification) and before anything counts severity — the verdict, the report and the run
// record all read the capped finding. The floor raises only at operator-recovery or worse, whose
// ceiling is Medium or above, so a floored finding is never lowered by the cap.
import { HARM_CEILING } from './harm-levels.mjs'
import { citesRepoRule, REPO_RULE_LEVEL } from './harm-repo-rule.mjs'

/** Severity ordering, worst first. */
const RANK = ['Critical', 'High', 'Medium', 'Low', 'Info']

/**
 * Gate lint seeds that report style and idiom: one that names no harm level names no harm at all,
 * so it is read as level `none` rather than left uncapped (a Medium pedantic seed must not warn).
 */
export const LINT_SEED_SOURCES = ['clippy-pedantic', 'statix', 'deadnix', 'fmt']

/** The words the cap's note carries in `why`. */
export const HARM_CAP_MARK = 'harm cap'

/**
 * The level the cap reads: the finding's own `harmLevel`, or `none` for a lint seed that names none
 * and for a `repo-rule` finding that cites no rule (its file and text, lib/harm-repo-rule.mjs).
 * @param {{ harmLevel?: string, harm?: string, source?: string, repoRule?: unknown }} f
 * @returns {string | undefined}
 */
export function effectiveLevel(f) {
  if (f.harmLevel === REPO_RULE_LEVEL && !citesRepoRule(f)) return 'none'
  if (f.harmLevel) return f.harmLevel
  if (!f.harm && LINT_SEED_SOURCES.includes(String(f.source ?? ''))) return 'none'
  return undefined
}

/** The level as the cap's note names it, saying why when it is not the finding's own. @param {string | undefined} level @param {string | undefined} own */
function levelNamed(level, own) {
  if (level === own) return level
  return `${level} (${own ? `${own} citing no rule file and text` : 'a lint seed naming no harm'})`
}

/**
 * `f` with its severity lowered to its harm level's ceiling, and a note saying so; `f` itself when it
 * names no level, its level is unknown, it already sits at or below the ceiling, or `exempt(f)`.
 * @template {{ severity?: string, why?: string, harmLevel?: string, harm?: string, source?: string, repoRule?: unknown }} F
 * @param {F} f
 * @param {(f: F) => boolean} [exempt]  strict mode's maintainability findings keep their escalated severity
 * @returns {F}
 */
export function capByHarm(f, exempt) {
  const level = effectiveLevel(f)
  const ceiling = level === undefined ? undefined : HARM_CEILING[level]
  if (!ceiling) return f
  const at = RANK.indexOf(String(f.severity ?? ''))
  if (at < 0 || at >= RANK.indexOf(ceiling)) return f
  if (exempt?.(f)) return f
  return { ...f, severity: ceiling, why: `${f.why ?? ''} (lowered to ${ceiling} from ${f.severity}: ${HARM_CAP_MARK} — harm level ${levelNamed(level, f.harmLevel)} allows at most ${ceiling})` }
}

/**
 * Every finding of a list through the cap, and how many it lowered.
 * @template {{ severity?: string, why?: string, harmLevel?: string, harm?: string, source?: string, repoRule?: unknown }} F
 * @param {F[]} list
 * @param {(f: F) => boolean} [exempt]
 * @returns {{ findings: F[], lowered: number }}
 */
export function applyHarmCap(list, exempt) {
  let lowered = 0
  const findings = list.map(f => {
    const g = capByHarm(f, exempt)
    if (g !== f) lowered++
    return g
  })
  return { findings, lowered }
}
