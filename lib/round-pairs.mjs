// Does a re-review get cheaper because it REMEMBERS (realm @nick/craft #97, #18)? Only a pair of
// consecutive review rounds in which nothing but memory differs can say. Every condition below names a
// way the two rounds can differ for another reason; a pair failing any of them is listed with that
// reason and NO numbers, so it cannot be read as an answer.
import { engineKey, isEngineAttributed } from './run-record.mjs'

// A top-level review round. A NESTED run (rust-audit's per-crate slice) is not a round of the chain —
// the chain's own selector skips it — and a partial record is a run that did not finish.
const isRound = r => r && r.schemaVersion && r.kind === 'workflow' && r.name === 'review' && !r.partial && !r.nested
  && Number.isInteger(r.round) && r.round >= 1 && typeof r.branch === 'string' && r.branch !== ''
const hasCost = r => !!(r.cost && Number.isFinite(r.cost.total) && r.cost.total > 0)
const lensAgents = r => (r.lensRounds || []).reduce((n, x) => n + (Number(x.agents) || 0), 0)
const sorted = xs => [...(xs || [])].map(String).sort().join(',')
// What the run was asked to do — a different configuration moves the cost by itself.
const config = r => JSON.stringify([sorted(r.languages), (r.scout || []).map(s => `${s.language}:${sorted(s.lenses)}`).sort(),
  sorted(r.optionalPass?.requested), !!r.strict])
const incomplete = r => (r.notRun || []).length > 0 || r.gate?.status === 'fail' || r.verification == null
  || /INCOMPLETE/.test(String(r.verdict))
// Memory in effect on the LATER round: chained, fingerprints comparable, nothing dropped. A record
// without the field (an older engine) cannot show it was — that fails closed.
const memoryIntact = r => !!r.reReview && r.reReview.chained === true && r.reReview.fpComparable !== false
  && r.reReview.basisMismatch !== true && !(Number(r.reReview.tombstonesDropped) > 0)

// The first failing condition, in order; 'clean' when none does.
const CHECKS = [
  ['engine-unknown', (a, b) => !isEngineAttributed(a) || !isEngineAttributed(b)],
  ['engine-changed', (a, b) => engineKey(a) !== engineKey(b)],
  ['diff-moved', (a, b) => !a.head || a.head !== b.head],
  ['dirty-tree', (a, b) => a.dirty !== false || b.dirty !== false],
  ['incomplete', (a, b) => incomplete(a) || incomplete(b)],
  ['scope-not-full', (a, b) => a.lensScope !== 'full' || b.lensScope !== 'full'],
  ['config-changed', (a, b) => config(a) !== config(b)],
  ['memory-degraded', (a, b) => !memoryIntact(b)],
  ['cost-missing', (a, b) => !hasCost(a) || !hasCost(b)],
]
export const REASON = {
  'engine-unknown': 'a round does not say which engine ran it — unknown is not "the same"',
  'engine-changed': 'engine changed between rounds — the rubric moves the cost by itself',
  'diff-moved': 'diff moved between rounds (head changed) — the drop includes the fix, not only memory',
  'dirty-tree': 'a round ran on a dirty working tree — uncommitted edits between rounds change the diff at the same head',
  'incomplete': 'a round did not run in full (gate failed, lenses not run, or no verification) — the drop is work not done',
  'scope-not-full': 'a round scanned only a delta (on an unchanged head that is an empty diff) — re-run with `fullEvery=1`',
  'config-changed': 'the rounds ran with different languages, lenses, optional pass or strict mode',
  'memory-degraded': 'the later round did not have its memory in full (not chained, fingerprints not comparable, or tombstones dropped)',
  'cost-missing': 'no real cost on both rounds — run `node lib/craft-log-run.mjs enrich-cost --run-dir <workflow transcript dir> --record <record>` on each',
}

const side = r => ({
  ts: r.ts, round: r.round, head: r.head || '',
  costTotal: hasCost(r) ? r.cost.total : null, cacheRead: hasCost(r) ? (r.cost.cacheRead || 0) : null,
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
      const status = (CHECKS.find(([, fails]) => fails(a, b)) || ['clean'])[0]
      const from = side(a)
      const to = side(b)
      const delta = status !== 'clean' ? null : {
        costTotal: to.costTotal - from.costTotal, costRatio: Math.round((to.costTotal / from.costTotal) * 100) / 100,
        cacheRead: to.cacheRead - from.cacheRead, agents: to.agents - from.agents, lensAgents: to.lensAgents - from.lensAgents,
        candidates: to.candidates - from.candidates, findings: to.findings - from.findings,
      }
      pairs.push({ project: b.project, branch: b.branch, from, to, status, delta })
    }
  }
  return pairs.sort((x, y) => String(x.to.ts).localeCompare(String(y.to.ts)))
}

const signed = n => `${n >= 0 ? '+' : ''}${n}`

export function renderRoundPairs(pairs) {
  if (!pairs.length) return '## Round pairs\nNo consecutive review rounds of one branch in this store.'
  const L = ['## Round pairs — does a re-review get cheaper?',
    '_Compared only when nothing but memory differs; every other pair is named with what confounds it._']
  for (const p of pairs) {
    const head = `- ${p.branch} (${p.project}) round ${p.from.round} → ${p.to.round}`
    if (p.status !== 'clean') { L.push(`${head}: ${REASON[p.status]}`); continue }
    const d = p.delta
    L.push(`${head}: cost ×${d.costRatio} (${p.from.costTotal} → ${p.to.costTotal}), cache read ${signed(d.cacheRead)}, agents ${signed(d.agents)}, lens dispatches ${signed(d.lensAgents)}, verified candidates ${signed(d.candidates)}, findings ${signed(d.findings)}`)
  }
  return L.join('\n')
}
