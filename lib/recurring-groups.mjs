// The grouping of lib/recurring-findings.mjs (realm @nick/craft, node #205): one project's runs, each a
// branch and its ledger rows, folded into groups of the same finding — the same file (or a file inside
// the group's path) and titles overlapping as a prior decision's must (decisionAnswers itself, one rule,
// realm @nick/craft, node #187) — and kept when seen on at least two DIFFERENT branches. Pure: no I/O.
import { decisionAnswers } from './prior-decisions.mjs'
import { SEVERITIES } from './run-record.mjs'

// The groups returned, most spread across branches first; the rest are counted in `groupsCut`.
export const RECURRING_GROUPS_MAX = 20
// The distinct titles one group lists; the rest are counted in `titlesMore`.
export const RECURRING_TITLES_MAX = 5

/**
 * @typedef {{ file: string, title: string, severity: string }} Row
 * @typedef {{ file: string, ts: string, branch: string, rows: Row[] }} Run
 * @typedef {{ file: string, titles: string[], titlesMore: number, branches: string[], runs: string[], severities: string[], lastSeen: string }} Group
 * @typedef {{ file: string, titles: Set<string>, branches: Set<string>, runs: Set<string>, severities: Set<string>, lastSeen: string }} Acc
 */

/**
 * Whether `row` is the finding of group `g`: its file inside the group's file, and its title
 * overlapping one of the group's titles as a prior decision's would.
 * @param {Row} row @param {Acc} g @returns {boolean}
 */
function sameFinding(row, g) {
  for (const title of g.titles) {
    const d = /** @type {import('./prior-decisions.mjs').PriorDecision} */ ({ scope: g.file, title })
    if (decisionAnswers(row, d)) return true
  }
  return false
}

/** Canonical severities first, in their order; any other spelling after them. @param {string} s */
const severityRank = s => {
  const i = /** @type {string[]} */ (SEVERITIES).indexOf(s)
  return i < 0 ? SEVERITIES.length : i
}

/** @param {Acc} a @returns {Group} */
function groupOut(a) {
  const titles = [...a.titles]
  return {
    file: a.file, titles: titles.slice(0, RECURRING_TITLES_MAX), titlesMore: Math.max(0, titles.length - RECURRING_TITLES_MAX),
    branches: [...a.branches].sort(), runs: [...a.runs].sort(), lastSeen: a.lastSeen,
    severities: [...a.severities].sort((x, y) => severityRank(x) - severityRank(y) || x.localeCompare(y)),
  }
}

/**
 * Groups the runs' findings and keeps those seen on at least two different branches.
 * @param {Run[]} runs @returns {{ groups: Group[], groupsCut: number }}
 */
export function recurringGroups(runs) {
  /** @type {Acc[]} */
  const acc = []
  for (const r of runs) {
    for (const row of r.rows) {
      let g = acc.find(x => sameFinding(row, x))
      if (!g) {
        g = { file: row.file, titles: new Set(), branches: new Set(), runs: new Set(), severities: new Set(), lastSeen: '' }
        acc.push(g)
      }
      g.titles.add(row.title)
      g.branches.add(r.branch)
      g.runs.add(r.file)
      if (row.severity) g.severities.add(row.severity)
      if (r.ts > g.lastSeen) g.lastSeen = r.ts
    }
  }
  const recurring = acc.filter(g => g.branches.size >= 2)
    .sort((a, b) => b.branches.size - a.branches.size || b.lastSeen.localeCompare(a.lastSeen) || a.file.localeCompare(b.file))
  return { groups: recurring.slice(0, RECURRING_GROUPS_MAX).map(groupOut), groupsCut: Math.max(0, recurring.length - RECURRING_GROUPS_MAX) }
}
