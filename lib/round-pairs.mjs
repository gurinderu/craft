// Does a re-review get cheaper because it REMEMBERS (realm @nick/craft #97, #18)? Only a pair of
// consecutive review rounds in which nothing but memory differs can say. Every condition below names a
// way the two rounds can differ for another reason; a pair failing any of them is listed with that
// reason and NO numbers, so it cannot be read as an answer.
import { engineKey, isEngineAttributed } from './run-record.mjs'

// A top-level review round. A NESTED run (rust-audit's per-crate slice) is not a round of the chain —
// the chain's own selector skips it — and a partial record is a run that did not finish.
const isRound = r => r && r.schemaVersion && r.kind === 'workflow' && r.name === 'review' && !r.partial && !r.nested
  && Number.isInteger(r.round) && r.round >= 1 && typeof r.branch === 'string' && r.branch !== ''
const arr = x => (Array.isArray(x) ? x : [])
const hasCost = r => !!(r.cost && Number.isFinite(r.cost.total) && r.cost.total > 0)
// enrich-cost counts transcripts it could not read in `skipped`; such a total is a lower bound, not a cost.
const partialCost = r => hasCost(r) && Number(r.cost.skipped) > 0
const lensAgents = r => arr(r.lensRounds).reduce((n, x) => n + (Number(x?.agents) || 0), 0)
const sorted = xs => arr(xs).map(String).sort().join(',')
// What the run was asked to do — a different configuration moves the cost by itself: languages, each
// language's lens set, lens model, planned rounds and verifier votes, the lenses the critic added on
// top, the optional pass, strict mode, and the caller's intent text (by digest).
const config = r => JSON.stringify([sorted(r.languages),
  arr(r.scout).map(s => [s?.language, sorted(s?.lenses), s?.model, s?.maxRounds, s?.verifyVotes, s?.size, s?.securitySensitive, s?.isLibrary].join(':')).sort(),
  sorted(r.criticFollowups), sorted(r.optionalPass?.requested), !!r.strict, r.intentDigest ?? null, r.specDigest ?? null])
// `notRun` must be a list that is empty; a missing or malformed one cannot show the run was complete.
// The gate must have PASSED: a gate that died ('unknown') ran none of its checks and seeded nothing.
const incomplete = r => !Array.isArray(r.notRun) || r.notRun.length > 0 || r.gate?.status !== 'pass' || r.verification == null
  || /INCOMPLETE|PARTIAL COVERAGE/i.test(String(r.verdict))
// Memory in effect on the LATER round: chained, its prior ledger carried intact and not rebuilt from a
// stalled run, fingerprints comparable, nothing dropped. A record without these fields (an older
// engine) cannot show it was — that fails closed.
const memoryIntact = r => !!r.reReview && r.reReview.chained === true && r.reReview.ledgerDegraded === false
  && r.reReview.journalSourced === false && r.reReview.fpComparable !== false
  && r.reReview.basisMismatch !== true && !(Number(r.reReview.tombstonesDropped) > 0)
// The later round says which round it chained from; the pair must be that round.
const chainedTo = (a, b) => b.reReview?.priorRound === a.round && !!b.reReview?.priorHead && b.reReview.priorHead === a.head
// The same diff: the head git reported for each record, the same base and path. (`head` is read when the
// record is written; the procedure keeps the tree untouched during and between the rounds.)
const sameDiff = (a, b) => !!a.head && a.head === b.head
  && typeof a.base === 'string' && a.base === b.base && (a.path || '') === (b.path || '')
  && !!a.filesDigest && a.filesDigest === b.filesDigest

/** @type {Array<[string, (a: any, b: any) => boolean]>} */
// The first failing condition, in order; 'clean' when none does.
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
  ['memory-degraded', (a, b) => !memoryIntact(b)],
  ['cost-missing', (a, b) => !hasCost(a) || !hasCost(b)],
  ['cost-partial', (a, b) => partialCost(a) || partialCost(b)],
  // Each cost must say which transcripts it was summed from, and they must be two different sets.
  ['cost-unbound', (a, b) => !a.cost.source || !b.cost.source || a.cost.source === b.cost.source],
]
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
const ms = ts => Date.parse(String(ts).replace(/T(\d\d)-(\d\d)-(\d\d)/, 'T$1:$2:$3'))

const side = r => ({
  ts: r.ts, round: r.round, head: r.head || '',
  costTotal: hasCost(r) ? r.cost.total : null, cacheRead: hasCost(r) ? (r.cost.cacheRead || 0) : null,
  input: hasCost(r) ? (r.cost.input || 0) : null, output: hasCost(r) ? (r.cost.output || 0) : null,
  cacheWrite: hasCost(r) ? (r.cost.cacheWrite || 0) : null,
  agents: hasCost(r) ? (r.cost.agents || 0) : null, lensAgents: lensAgents(r),
  candidates: Number(r.verification?.candidates) || 0, findings: Number(r.findings?.total ?? r.findingsTotal) || 0,
})

// Each round n+1 is paired with the newest round-n record of its project and branch that came BEFORE
// it — a chain restarted later (--fresh, a rejected prior) is not the round it remembered.
export function roundPairs(records) {
  const groups = new Map()
  for (const r of (records || []).filter(isRound)) {
    const k = `${r.project}\u0000${r.branch}`
    groups.set(k, [...(groups.get(k) || []), r])
  }
  const pairs = []
  for (const rs of groups.values()) {
    for (const b of rs) {
      const a = rs.filter(r => r.round === b.round - 1 && String(r.ts) < String(b.ts))
        .sort((x, y) => String(y.ts).localeCompare(String(x.ts)))[0]
      if (!a) continue
      let status
      let error = null
      try { status = (CHECKS.find(([, fails]) => fails(a, b)) || ['clean'])[0] } catch (e) { status = 'malformed'; error = String(e?.message || e) }
      const from = side(a)
      const to = side(b)
      const delta = status !== 'clean' ? null : {
        costTotal: to.costTotal - from.costTotal, costRatio: Math.round((to.costTotal / from.costTotal) * 100) / 100,
        cacheRead: to.cacheRead - from.cacheRead, cacheWrite: to.cacheWrite - from.cacheWrite, input: to.input - from.input, output: to.output - from.output, agents: to.agents - from.agents, lensAgents: to.lensAgents - from.lensAgents,
        candidates: to.candidates - from.candidates, findings: to.findings - from.findings,
        minutesApart: Math.round((ms(b.ts) - ms(a.ts)) / 60000),
      }
      pairs.push({ project: b.project, branch: b.branch, from, to, status, delta, ...(error ? { error } : {}) })
    }
  }
  return pairs.sort((x, y) => String(x.to.ts).localeCompare(String(y.to.ts)))
}

const signed = n => `${n >= 0 ? '+' : ''}${n}`

// Review records that are not rounds of a chain, by reason — counted, so a pair that is missing because
// its round did not finish (or never said its branch or round) is not silently absent.
export function excludedRounds(records) {
  const out = {}
  for (const r of (records || []).filter(r => r && r.kind === 'workflow' && r.name === 'review' && !isRound(r))) {
    const why = r.partial ? 'did not finish' : r.nested ? 'nested per-crate run' : !r.schemaVersion ? 'pre-telemetry'
      : !(Number.isInteger(r.round) && r.round >= 1) ? 'no round' : 'no branch (e.g. a detached HEAD)'
    out[why] = (out[why] || 0) + 1
  }
  return out
}

export function renderRoundPairs(pairs, excluded = {}) {
  const n = Object.values(excluded).reduce((a, b) => a + b, 0)
  const note = n ? `\n_${n} review record(s) are not rounds and pair with nothing: ${Object.entries(excluded).map(([k, v]) => `${v} ${k}`).join(', ')}._` : ''
  if (!pairs.length) return `## Round pairs\nNo consecutive review rounds of one branch in this store.${note}`
  const L = ['## Round pairs — does a re-review get cheaper?',
    '_Compared only when nothing but memory differs; every other pair is named with what confounds it. Token counts are an unweighted sum across kinds (a cache read is priced far below output), so read the per-kind deltas, not the ratio alone, as money._' + note]
  for (const p of pairs) {
    const head = `- ${p.branch} (${p.project}) round ${p.from.round} → ${p.to.round}`
    if (p.status !== 'clean') { L.push(`${head}: ${REASON[p.status]}${p.error ? ` (${p.error})` : ''}`); continue }
    const d = p.delta
    L.push(`${head}: tokens ×${d.costRatio} (${p.from.costTotal} → ${p.to.costTotal}): output ${signed(d.output)}, input ${signed(d.input)}, cache read ${signed(d.cacheRead)}, cache write ${signed(d.cacheWrite)} (${Number.isFinite(d.minutesApart) ? `${d.minutesApart} min apart — a prompt cache still warm from round ${p.from.round} lowers the later round's input` : 'time apart unknown'}); agents ${signed(d.agents)}, lens dispatches ${signed(d.lensAgents)}, verified candidates ${signed(d.candidates)}, findings ${signed(d.findings)}`)
  }
  return L.join('\n')
}
