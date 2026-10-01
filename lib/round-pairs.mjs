// Does a re-review get cheaper because it REMEMBERS (realm @nick/craft #97, #18)? Only a pair of
// consecutive review rounds in which nothing but memory differs can say: the same head (a frozen diff —
// a fix pushed between rounds shrinks the work for a reason that is not memory), the same engine (a
// rubric change moves the cost by itself), and a REAL cost on both (craft-log-run enrich-cost — the
// harness token pool is not a cost, #17/#96). Every other pair is labelled with what confounds it and
// carries no numbers, so it cannot be read as an answer.
import { engineKey } from './run-record.mjs'

const isRound = r => r && r.schemaVersion && r.kind === 'workflow' && r.name === 'review' && !r.partial
  && Number.isInteger(r.round) && r.round >= 1 && typeof r.branch === 'string' && r.branch !== ''
const hasCost = r => r.cost && Number.isFinite(r.cost.total) && r.cost.total > 0
const lensAgents = r => (r.lensRounds || []).reduce((n, x) => n + (Number(x.agents) || 0), 0)

function side(r) {
  return {
    ts: r.ts, round: r.round, head: r.head || '', engine: engineKey(r),
    costTotal: hasCost(r) ? r.cost.total : null,
    cacheRead: hasCost(r) ? (r.cost.cacheRead || 0) : null,
    agents: hasCost(r) ? (r.cost.agents || 0) : null,
    lensAgents: lensAgents(r),
    candidates: Number(r.verification?.candidates) || 0,
    findings: Number(r.findings?.total ?? r.findingsTotal) || 0,
  }
}

function statusOf(a, b) {
  if (!a.head || a.head !== b.head) return 'diff-moved'
  if (a.engine !== b.engine) return 'engine-changed'
  if (a.costTotal === null || b.costTotal === null) return 'cost-missing'
  return 'clean'
}

// Consecutive rounds (n, n+1) of one project and branch. When a round number repeats (a re-run of the
// same round), the newest record of it stands for it.
export function roundPairs(records) {
  const groups = new Map()
  for (const r of (records || []).filter(isRound)) {
    const k = `${r.project}\u0000${r.branch}`
    const byRound = groups.get(k) || new Map()
    const prev = byRound.get(r.round)
    if (!prev || String(r.ts) > String(prev.ts)) byRound.set(r.round, r)
    groups.set(k, byRound)
  }
  const pairs = []
  for (const byRound of groups.values()) {
    for (const [n, a] of byRound) {
      const b = byRound.get(n + 1)
      if (!b) continue
      const from = side(a)
      const to = side(b)
      const status = statusOf(from, to)
      const delta = status !== 'clean' ? null : {
        costTotal: to.costTotal - from.costTotal,
        costRatio: Math.round((to.costTotal / from.costTotal) * 100) / 100,
        cacheRead: to.cacheRead - from.cacheRead,
        agents: to.agents - from.agents,
        lensAgents: to.lensAgents - from.lensAgents,
      }
      pairs.push({ project: a.project, branch: a.branch, from, to, status, delta })
    }
  }
  return pairs.sort((x, y) => String(x.to.ts).localeCompare(String(y.to.ts)))
}

const REASON = {
  'diff-moved': 'diff moved between rounds (head changed) — the drop includes the fix, not only memory',
  'engine-changed': 'engine changed between rounds — the rubric moves the cost by itself',
  'cost-missing': 'no real cost on both rounds — run `node lib/craft-log-run.mjs enrich-cost --run-dir <workflow transcript dir> --record <record>` on each',
}

export function renderRoundPairs(pairs) {
  if (!pairs.length) return '## Round pairs\nNo consecutive review rounds of one branch in this store.'
  const L = ['## Round pairs — does a re-review get cheaper?',
    '_Compared only on a frozen diff, one engine and a real cost; every other pair is named with what confounds it._']
  for (const p of pairs) {
    const head = `- ${p.branch} (${p.project}) round ${p.from.round} → ${p.to.round}`
    if (p.status !== 'clean') { L.push(`${head}: ${REASON[p.status]}`); continue }
    const d = p.delta
    L.push(`${head}: cost ×${d.costRatio} (${p.from.costTotal} → ${p.to.costTotal}), cache read ${d.cacheRead >= 0 ? '+' : ''}${d.cacheRead}, agents ${d.agents >= 0 ? '+' : ''}${d.agents}, lens dispatches ${d.lensAgents >= 0 ? '+' : ''}${d.lensAgents}`)
  }
  return L.join('\n')
}
