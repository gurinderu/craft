// Does a re-review get cheaper because it REMEMBERS (realm @nick/craft #97, #18)? Only a pair of
// consecutive review rounds in which nothing but memory differs can say. Every condition below names a
// way the two rounds can differ for another reason; a pair failing any of them is listed with that
// reason and NO numbers, so it cannot be read as an answer.
import { engineKey, isEngineAttributed } from './run-record.mjs'

/**
 * The fields of a stored run record this module reads. Records are parsed JSON written by several
 * engine revisions, so every field is optional and any of them may be missing or malformed.
 * @typedef {{ total?: number, cacheRead?: unknown, cacheWrite?: unknown, input?: unknown, output?: unknown,
 *   agents?: unknown, skipped?: unknown, source?: unknown }} Cost
 * @typedef {{ chained?: boolean, ledgerDegraded?: boolean, journalSourced?: boolean, fpComparable?: boolean,
 *   basisMismatch?: boolean, tombstonesDropped?: number, priorRound?: number, priorHead?: string }} ReReview
 * @typedef {{ language?: string, lenses?: unknown[], model?: string, maxRounds?: number, verifyVotes?: number,
 *   size?: string, securitySensitive?: boolean, isLibrary?: boolean }} Scout
 * @typedef {{ schemaVersion?: number, kind?: string, name?: string, partial?: boolean, nested?: boolean,
 *   round?: number, branch?: string, project?: string, ts?: string, head?: string, base?: string,
 *   path?: string, filesDigest?: string, dirty?: boolean, verdict?: unknown, notRun?: unknown[],
 *   gate?: { status?: string }, verification?: { candidates?: number } | null, lensScope?: string,
 *   intentDigest?: string | null, specDigest?: string | null, languages?: unknown[], scout?: Scout[],
 *   criticFollowups?: unknown[], optionalPass?: { requested?: unknown[] }, strict?: boolean,
 *   lensRounds?: Array<{ agents?: number }>, cost?: Cost, reReview?: ReReview,
 *   findings?: { total?: number }, findingsTotal?: number, runtime?: unknown, craftVersion?: unknown,
 *   workflowEngineRevision?: unknown, engineRevision?: unknown }} Rec
 * @typedef {Rec & { round: number, branch: string }} Round
 * @typedef {{ costTotal: number, cacheRead: number, cacheWrite: number, input: number, output: number,
 *   agents: number, lensAgents: number, candidates: number, findings: number }} Costed
 * @typedef {ReturnType<typeof side>} Side
 * @typedef {{ project: string | undefined, branch: string, from: Side, to: Side, status: string,
 *   delta: Delta | null, error?: string }} Pair
 * @typedef {{ costTotal: number, costRatio: number, cacheRead: number, cacheWrite: number, input: number,
 *   output: number, agents: number, lensAgents: number, candidates: number, findings: number,
 *   minutesApart: number }} Delta
 */

// A top-level review round. A NESTED run (rust-audit's per-crate slice) is not a round of the chain —
// the chain's own selector skips it — and a partial record is a run that did not finish.
/** @param {Rec} r @returns {r is Round} */
const isRound = r => Boolean(r && r.schemaVersion && r.kind === 'workflow' && r.name === 'review' && !r.partial && !r.nested
  && Number.isInteger(r.round) && /** @type {number} */ (r.round) >= 1 && typeof r.branch === 'string' && r.branch !== '')
/** @param {unknown} x @returns {any[]} */
const arr = x => (Array.isArray(x) ? x : [])
/** @param {Rec} r @returns {r is Rec & { cost: Cost & { total: number } }} */
const hasCost = r => !!(r.cost && Number.isFinite(r.cost.total) && /** @type {number} */ (r.cost.total) > 0)
// enrich-cost counts transcripts it could not read in `skipped`; such a total is a lower bound, not a cost.
/** @param {Rec} r */
const partialCost = r => hasCost(r) && Number(r.cost.skipped) > 0
/** @param {Rec} r */
const lensAgents = r => arr(r.lensRounds).reduce((n, x) => n + (Number(x?.agents) || 0), 0)
/** @param {unknown} xs */
const sorted = xs => arr(xs).map(String).sort().join(',')
// What the run was asked to do — a different configuration moves the cost by itself: languages, each
// language's lens set, lens model, planned rounds and verifier votes, the lenses the critic added on
// top, the optional pass, strict mode, and the caller's intent text (by digest).
/** @param {Rec} r */
const config = r => JSON.stringify([sorted(r.languages),
  arr(r.scout).map(s => [s?.language, sorted(s?.lenses), s?.model, s?.maxRounds, s?.verifyVotes, s?.size, s?.securitySensitive, s?.isLibrary].join(':')).sort(),
  sorted(r.criticFollowups), sorted(r.optionalPass?.requested), !!r.strict, r.intentDigest ?? null, r.specDigest ?? null])
// `notRun` must be a list that is empty; a missing or malformed one cannot show the run was complete.
// The gate must have PASSED: a gate that died ('unknown') ran none of its checks and seeded nothing.
/** @param {Rec} r */
const incomplete = r => !Array.isArray(r.notRun) || r.notRun.length > 0 || r.gate?.status !== 'pass' || r.verification == null
  || /INCOMPLETE|PARTIAL COVERAGE/i.test(String(r.verdict))
// Memory in effect on the LATER round: chained, its prior ledger carried intact and not rebuilt from a
// stalled run, fingerprints comparable, nothing dropped. A record without these fields (an older
// engine) cannot show it was — that fails closed.
/** @param {Rec} r */
const memoryIntact = r => !!r.reReview && r.reReview.chained === true && r.reReview.ledgerDegraded === false
  && r.reReview.journalSourced === false && r.reReview.fpComparable !== false
  && r.reReview.basisMismatch !== true && !(Number(r.reReview.tombstonesDropped) > 0)
// The later round says which round it chained from; the pair must be that round.
/** @param {Rec} a @param {Rec} b */
const chainedTo = (a, b) => b.reReview?.priorRound === a.round && !!b.reReview?.priorHead && b.reReview.priorHead === a.head
// The same diff: the head git reported for each record, the same base and path. (`head` is read when the
// record is written; the procedure keeps the tree untouched during and between the rounds.)
/** @param {Rec} a @param {Rec} b */
const sameDiff = (a, b) => !!a.head && a.head === b.head
  && typeof a.base === 'string' && a.base === b.base && (a.path || '') === (b.path || '')
  && !!a.filesDigest && a.filesDigest === b.filesDigest

// The first failing condition, in order; 'clean' when none does.
/** @type {Array<[string, (a: Rec, b: Rec) => boolean]>} */
const CHECKS = [
  ['engine-unknown', (a, b) => !isEngineAttributed(a) || !isEngineAttributed(b)],
  ['engine-changed', (a, b) => engineKey(a) !== engineKey(b)],
  ['prior-unconfirmed', (a, b) => !chainedTo(a, b)],
  ['diff-moved', (a, b) => !sameDiff(a, b)],
  ['dirty-tree', (a, b) => a.dirty !== false || b.dirty !== false],
  ['incomplete', (a, b) => incomplete(a) || incomplete(b)],
  ['scope-not-full', (a, b) => a.lensScope !== 'full' || b.lensScope !== 'full'],
  // A record that does not carry the digests cannot show what it was given: two such records are not
  // "the same input", they are two unknowns — fail closed rather than compare undefined with undefined.
  ['config-unknown', (a, b) => [a, b].some(r => typeof r.intentDigest !== 'string' || typeof r.specDigest !== 'string')],
  ['config-changed', (a, b) => config(a) !== config(b)],
  ['memory-degraded', (_a, b) => !memoryIntact(b)],
  ['cost-missing', (a, b) => !hasCost(a) || !hasCost(b)],
  ['cost-partial', (a, b) => partialCost(a) || partialCost(b)],
  // Each cost must say which transcripts it was summed from, and they must be two different sets.
  // Reached only past 'cost-missing', so both records carry a cost.
  ['cost-unbound', (a, b) => {
    const ca = /** @type {Cost} */ (a.cost)
    const cb = /** @type {Cost} */ (b.cost)
    return !ca.source || !cb.source || ca.source === cb.source
  }],
]
/** @type {Record<string, string>} */
export const REASON = {
  'engine-unknown': 'a round does not say which engine ran it — unknown is not "the same"',
  'engine-changed': 'engine changed between rounds — the rubric moves the cost by itself',
  'prior-unconfirmed': 'the later round does not say it chained from this round (its recorded prior round and head differ, or are missing)',
  'diff-moved': 'the rounds did not review the same diff (head, base, path or changed-file set differ, or are missing) — the drop includes the change, not only memory',
  'dirty-tree': 'a round ran on a dirty working tree — uncommitted edits between rounds change the diff at the same head',
  'incomplete': 'a round did not run in full (gate did not pass, lenses not run, no verification, or partial coverage) — the drop is work not done',
  'scope-not-full': 'a round scanned only a delta (on an unchanged head that is an empty diff) — re-run with `fullEvery=1`',
  'config-unknown': 'a round does not record what it was given (no intent or description digest) — an unknown input is not the same input',
  'config-changed': 'the rounds ran with a different configuration (languages, lenses, lens model, rounds, votes, size, security/library classification, critic follow-ups, optional pass, strict mode, intent or the author\'s description)',
  'memory-degraded': 'the later round did not have its memory in full (not chained, fingerprints not comparable, or tombstones dropped)',
  'malformed': 'a record of this pair does not have the shape of a review record — it cannot be judged',
  'cost-unbound': 'the two costs do not come from two distinct runs (no recorded source, or the same transcripts summed into both)',
  'cost-partial': 'a round\'s cost is partial (enrich-cost skipped transcripts it could not read) — a lower bound is not a cost',
  'cost-missing': 'no real cost on both rounds — run `node lib/craft-log-run.mjs enrich-cost --run-dir <workflow transcript dir> --record <record>` on each',
}

// The stored timestamp ('2026-10-01T15-50-24Z') as milliseconds; NaN when it is not one.
/** @param {unknown} ts */
const ms = ts => Date.parse(String(ts).replace(/T(\d\d)-(\d\d)-(\d\d)/, 'T$1:$2:$3'))

/** @param {Rec} r */
const side = r => ({
  ts: r.ts, round: r.round, head: r.head || '',
  costTotal: hasCost(r) ? r.cost.total : null, cacheRead: hasCost(r) ? (Number(r.cost.cacheRead) || 0) : null,
  input: hasCost(r) ? (Number(r.cost.input) || 0) : null, output: hasCost(r) ? (Number(r.cost.output) || 0) : null,
  cacheWrite: hasCost(r) ? (Number(r.cost.cacheWrite) || 0) : null,
  agents: hasCost(r) ? (Number(r.cost.agents) || 0) : null, lensAgents: lensAgents(r),
  candidates: Number(r.verification?.candidates) || 0, findings: Number(r.findings?.total ?? r.findingsTotal) || 0,
})

// Each round n+1 is paired with the newest round-n record of its project and branch that came BEFORE
// it — a chain restarted later (--fresh, a rejected prior) is not the round it remembered.
/** @param {Rec[] | null | undefined} records @returns {Pair[]} */
export function roundPairs(records) {
  /** @type {Map<string, Round[]>} */
  const groups = new Map()
  for (const r of /** @type {Rec[]} */ (records || []).filter(isRound)) {
    const k = `${r.project}\u0000${r.branch}`
    groups.set(k, [...(groups.get(k) || []), r])
  }
  /** @type {Pair[]} */
  const pairs = []
  for (const rs of groups.values()) {
    for (const b of rs) {
      const a = rs.filter(r => r.round === b.round - 1 && String(r.ts) < String(b.ts))
        .sort((x, y) => String(y.ts).localeCompare(String(x.ts)))[0]
      if (!a) continue
      let status
      let error = null
      try { status = (CHECKS.find(([, fails]) => fails(a, b)) || ['clean'])[0] } catch (e) { status = 'malformed'; error = String(/** @type {any} */ (e)?.message || e) }
      const from = side(a)
      const to = side(b)
      // A 'clean' pair passed 'cost-missing', so `side` filled every cost field with a number.
      const cf = /** @type {Costed} */ (from)
      const ct = /** @type {Costed} */ (to)
      const delta = status !== 'clean' ? null : {
        costTotal: ct.costTotal - cf.costTotal, costRatio: Math.round((ct.costTotal / cf.costTotal) * 100) / 100,
        cacheRead: ct.cacheRead - cf.cacheRead, cacheWrite: ct.cacheWrite - cf.cacheWrite, input: ct.input - cf.input, output: ct.output - cf.output, agents: ct.agents - cf.agents, lensAgents: ct.lensAgents - cf.lensAgents,
        candidates: ct.candidates - cf.candidates, findings: ct.findings - cf.findings,
        minutesApart: Math.round((ms(b.ts) - ms(a.ts)) / 60000),
      }
      pairs.push({ project: b.project, branch: b.branch, from, to, status, delta, ...(error ? { error } : {}) })
    }
  }
  return pairs.sort((x, y) => String(x.to.ts).localeCompare(String(y.to.ts)))
}

/** @param {number} n */
const signed = n => `${n >= 0 ? '+' : ''}${n}`

// Review records that are not rounds of a chain, by reason — counted, so a pair that is missing because
// its round did not finish (or never said its branch or round) is not silently absent.
/** @param {Rec[] | null | undefined} records @returns {Record<string, number>} */
export function excludedRounds(records) {
  /** @type {Record<string, number>} */
  const out = {}
  for (const r of /** @type {Rec[]} */ (records || []).filter(r => r && r.kind === 'workflow' && r.name === 'review' && !isRound(r))) {
    const why = r.partial ? 'did not finish' : r.nested ? 'nested per-crate run' : !r.schemaVersion ? 'pre-telemetry'
      : !(Number.isInteger(r.round) && /** @type {number} */ (r.round) >= 1) ? 'no round' : 'no branch (e.g. a detached HEAD)'
    out[why] = (out[why] || 0) + 1
  }
  return out
}

/** @param {Pair[]} pairs @param {Record<string, number>} [excluded] @returns {string} */
export function renderRoundPairs(pairs, excluded = {}) {
  const n = Object.values(excluded).reduce((a, b) => a + b, 0)
  const note = n ? `\n_${n} review record(s) are not rounds and pair with nothing: ${Object.entries(excluded).map(([k, v]) => `${v} ${k}`).join(', ')}._` : ''
  if (!pairs.length) return `## Round pairs\nNo consecutive review rounds of one branch in this store.${note}`
  const L = ['## Round pairs — does a re-review get cheaper?',
    '_Compared only when nothing but memory differs; every other pair is named with what confounds it. Token counts are an unweighted sum across kinds (a cache read is priced far below output), so read the per-kind deltas, not the ratio alone, as money._' + note]
  for (const p of pairs) {
    const head = `- ${p.branch} (${p.project}) round ${p.from.round} → ${p.to.round}`
    if (p.status !== 'clean') { L.push(`${head}: ${REASON[p.status]}${p.error ? ` (${p.error})` : ''}`); continue }
    // A pair that is not 'clean' continued above; a 'clean' one always carries a delta.
    const d = /** @type {Delta} */ (p.delta)
    L.push(`${head}: tokens ×${d.costRatio} (${p.from.costTotal} → ${p.to.costTotal}): output ${signed(d.output)}, input ${signed(d.input)}, cache read ${signed(d.cacheRead)}, cache write ${signed(d.cacheWrite)} (${Number.isFinite(d.minutesApart) ? `${d.minutesApart} min apart — a prompt cache still warm from round ${p.from.round} lowers the later round's input` : 'time apart unknown'}); agents ${signed(d.agents)}, lens dispatches ${signed(d.lensAgents)}, verified candidates ${signed(d.candidates)}, findings ${signed(d.findings)}`)
  }
  return L.join('\n')
}
