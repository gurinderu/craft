// craft run-record analyzer — reads the ~/.craft/runs store and surfaces the signals a
// self-improvement loop needs (see docs/superpowers/specs/2026-07-10-self-improvement-design.md):
//
//   - NOT RUN frequency per lens/dimension — FRAGILITY. A lens that keeps failing to return (the
//     missing-agent-type bug is exactly this) is the first thing to fix; a broken finder produces
//     no signal at all.
//   - run-level refute rate per workflow — NOISE. Finders whose findings are mostly refuted
//     downstream are over-firing; their prompt/rubric is the mutation target. Per-LENS refute rate
//     (from each dimension's confirmed/suspected/refuted counts) pinpoints WHICH finder over-fires —
//     the signal the design wanted; only present on runs recorded after the per-lens telemetry landed.
//   - per-dimension confirmed volume — YIELD. A lens that runs often but confirms nothing is either
//     miscalibrated or redundant.
//   - verdict / INCOMPLETE rates — overall health.
//
// `aggregate(records)` is pure and unit-tested; the CLI reads the detail JSON files and prints a
// report. Run: `node lib/analyze-runs.mjs [dir]` (dir defaults to ~/.craft/runs).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info']

const round2 = n => Math.round(n * 100) / 100
const isIncomplete = v => /INCOMPLETE/i.test(String(v || ''))
// A per-lens refute rate needs a minimum candidate pool before it means anything — one refuted
// finding out of one is not "an over-firing lens". Below this, a lens is omitted from the NOISE rank.
const MIN_REFUTE_CANDIDATES = 4
// ...and a lens is only NOISY if it actually over-refutes. Without a floor the section listed EVERY
// lens with enough candidates — including ones at refute 0.00 — each under the header "over-refuting"
// and the advice "tighten this lens's rubric". That advice is backwards for a precise lens: tightening
// it suppresses findings that were all being confirmed. Observed on a 60-run store, where 13 of 13
// ranked lenses were listed and the bottom two sat at 0/9 and 0/5.
const MIN_REFUTE_RATE = 0.25

// Pure: array of parsed run records → structured summary. Tolerant of malformed / partial records.
export function aggregate(records) {
  const recs = (Array.isArray(records) ? records : []).filter(r => r && typeof r === 'object')
  const byWorkflow = {}
  const notRun = {}
  const byDimension = {}
  let incompleteRuns = 0

  for (const r of recs) {
    const name = r.name || '(unknown)'
    const w = byWorkflow[name] || (byWorkflow[name] = {
      runs: 0, block: 0, warning: 0, approve: 0, incomplete: 0,
      refuteRateSum: 0, refuteRateN: 0, candidates: 0, confirmed: 0, outputTokens: 0, outputTokensN: 0,
    })
    w.runs++
    const v = String(r.verdict || '')
    if (isIncomplete(v)) { w.incomplete++; incompleteRuns++ }
    if (/Block|At-risk|UB-found/i.test(v)) w.block++
    else if (/Warning|Concerns/i.test(v)) w.warning++
    else if (/Approve|Healthy|Clean/i.test(v)) w.approve++

    const ver = r.verification
    if (ver && typeof ver === 'object') {
      if (typeof ver.refuteRate === 'number') { w.refuteRateSum += ver.refuteRate; w.refuteRateN++ }
      if (typeof ver.candidates === 'number') w.candidates += ver.candidates
      if (typeof ver.confirmed === 'number') w.confirmed += ver.confirmed
    }
    if (typeof r.outputTokens === 'number') { w.outputTokens += r.outputTokens; w.outputTokensN++ }

    for (const item of (Array.isArray(r.notRun) ? r.notRun : [])) {
      const k = String(item)
      notRun[k] = (notRun[k] || 0) + 1
    }
    for (const dim of (Array.isArray(r.dimensions) ? r.dimensions : [])) {
      if (!dim || typeof dim !== 'object') continue
      const k = String(dim.dimension || '(unnamed)')
      const agg = byDimension[k] || (byDimension[k] = { runs: 0, dead: 0, findings: 0, confirmed: 0, suspected: 0, refuted: 0, bySeverity: { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 } })
      // A dimension row exists for every PLANNED lens, so a lens that never returned looks identical
      // to one that ran and found nothing — and yield-per-run silently divides by the dead runs too.
      // `ran: false` marks the dead ones; records predating the flag have no way to tell, so they
      // count as having run (the previous behaviour) rather than being guessed at.
      if (dim.ran === false) { agg.dead++; continue }
      agg.runs++
      agg.findings += Number(dim.findingCount) || 0
      // Per-lens survival — present only on records written after the per-lens telemetry landed.
      // Absent fields read as 0, so an old-schema run contributes runs/findings but no refute signal.
      agg.confirmed += Number(dim.confirmedCount) || 0
      agg.suspected += Number(dim.suspectedCount) || 0
      agg.refuted += Number(dim.refutedCount) || 0
      const bs = dim.bySeverity || {}
      for (const s of SEVERITIES) agg.bySeverity[s] += Number(bs[s]) || 0
    }
  }

  const workflows = Object.entries(byWorkflow).map(([name, w]) => ({
    name,
    runs: w.runs,
    verdicts: { block: w.block, warning: w.warning, approve: w.approve, incomplete: w.incomplete },
    avgRefuteRate: w.refuteRateN ? round2(w.refuteRateSum / w.refuteRateN) : null,
    candidates: w.candidates,
    confirmed: w.confirmed,
    avgOutputTokens: w.outputTokensN ? Math.round(w.outputTokens / w.outputTokensN) : null,
  })).sort((a, b) => b.runs - a.runs)

  const notRunRanked = Object.entries(notRun)
    .map(([item, count]) => ({ item, count }))
    .sort((a, b) => b.count - a.count || a.item.localeCompare(b.item))

  const dimensions = Object.entries(byDimension).map(([dimension, d]) => {
    const candidates = d.confirmed + d.suspected + d.refuted
    return {
      dimension, runs: d.runs, dead: d.dead, findings: d.findings, bySeverity: d.bySeverity,
      findingsPerRun: d.runs ? round2(d.findings / d.runs) : 0,
      confirmed: d.confirmed, suspected: d.suspected, refuted: d.refuted, candidates,
      // null (not 0) when there is no per-lens verification data, so old runs don't read as "0% refute".
      refuteRate: candidates ? round2(d.refuted / candidates) : null,
    }
  }).sort((a, b) => b.findings - a.findings || a.dimension.localeCompare(b.dimension))

  return { totalRuns: recs.length, incompleteRuns, workflows, notRun: notRunRanked, dimensions }
}

// ---- CLI ----
// Returns {records, unreadable} — or null when the store directory does not exist.
// `unreadable` is load-bearing, not a diagnostic nicety: a record that fails to parse is a run whose
// telemetry is GONE, and silently dropping it makes the store look smaller rather than damaged. A
// 60-run store was found holding a 0-byte record (a write that died mid-flight); the count mismatch
// against the file listing was the only trace, and nothing in the report mentioned it.
export function loadRecords(dir) {
  let files
  try { files = fs.readdirSync(dir) } catch { return null }
  const records = []
  const unreadable = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue   // skips index.jsonl and README.md
    try {
      records.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    } catch (e) {
      unreadable.push({ file: f, reason: String((e && e.message) || e).slice(0, 80) })
    }
  }
  return { records, unreadable }
}

export function renderReport(a) {
  const L = [`# craft run analysis — ${a.totalRuns} run(s), ${a.incompleteRuns} incomplete`, '']
  L.push('## Workflows')
  for (const w of a.workflows) {
    L.push(`- ${w.name}: ${w.runs} run(s) · B/W/A ${w.verdicts.block}/${w.verdicts.warning}/${w.verdicts.approve}`
      + `${w.verdicts.incomplete ? ` · ${w.verdicts.incomplete} incomplete` : ''}`
      + `${w.avgRefuteRate != null ? ` · avg refute ${w.avgRefuteRate}` : ''}`
      + `${w.avgOutputTokens != null ? ` · ~${w.avgOutputTokens} out-tok/run` : ''}`)
  }
  L.push('', '## NOT RUN — fragility (highest first)')
  if (a.notRun.length) for (const n of a.notRun) L.push(`- ${n.count}× ${n.item}`)
  else L.push('- none')
  L.push('', '## Dimensions — confirmed findings (highest first)')
  if (a.dimensions.length) for (const d of a.dimensions) {
    const sev = SEVERITIES.filter(s => d.bySeverity[s]).map(s => `${s[0]}${d.bySeverity[s]}`).join(' ') || '—'
    L.push(`- ${d.dimension}: ${d.findings} finding(s) / ${d.runs} run(s) (${d.findingsPerRun}/run) · ${sev}`
      + `${d.refuteRate != null ? ` · refute ${d.refuteRate} (${d.refuted}/${d.candidates})` : ''}`
      + `${d.dead ? ` · ⚠️ ${d.dead} run(s) it never returned` : ''}`)
  } else L.push('- none')
  L.push('', `## NOISE — lenses over-refuting (refute ≥ ${MIN_REFUTE_RATE}, ≥${MIN_REFUTE_CANDIDATES} candidates)`)
  const rated = a.dimensions.filter(d => d.refuteRate != null && d.candidates >= MIN_REFUTE_CANDIDATES)
  const noisy = rated
    .filter(d => d.refuteRate >= MIN_REFUTE_RATE)
    .sort((x, y) => y.refuteRate - x.refuteRate || y.candidates - x.candidates)
  if (noisy.length) for (const d of noisy) {
    L.push(`- ${d.dimension}: refute ${d.refuteRate} (${d.refuted}/${d.candidates}) · ${d.confirmed} confirmed — tighten this lens's rubric`)
  } else if (rated.length) {
    L.push(`- none — all ${rated.length} lens(es) with enough candidates refute below ${MIN_REFUTE_RATE}`)
  } else L.push('- no per-lens refute data yet (needs runs recorded after the per-lens telemetry landed)')
  return L.join('\n')
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const dir = process.argv[2] || path.join(os.homedir(), '.craft', 'runs')
  const loaded = loadRecords(dir)
  if (loaded === null) {
    console.log(`No run store at ${dir} — nothing to analyze yet. Run some reviews first.`)
    process.exit(0)
  }
  const { records, unreadable } = loaded
  // Records that parse but carry no schemaVersion are pre-telemetry runs — excluded from the
  // aggregate on purpose, but counted out loud so the report's run total is explainable.
  const usable = records.filter(r => r && r.schemaVersion)
  console.log(renderReport(aggregate(usable)))
  const legacy = records.length - usable.length
  if (legacy) console.log(`\n_${legacy} record(s) skipped: no schemaVersion (pre-telemetry runs)._`)
  if (unreadable.length) {
    console.log(`\n## ⚠️ Unreadable records — ${unreadable.length} run(s) of telemetry lost`)
    for (const u of unreadable) console.log(`- ${u.file} — ${u.reason}`)
  }
}
