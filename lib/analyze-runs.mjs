// craft run-record analyzer — reads the ~/.craft/runs store and surfaces the signals a
// self-improvement loop needs. (The design spec this was built from lived at
// docs/superpowers/specs/2026-07-10-self-improvement-design.md and was removed with that whole
// directory; it is recoverable from git history via `git log --diff-filter=D -- docs/superpowers/`.
// The signals themselves are enumerated below, which is what a reader actually needs.)
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
import { engineKey, isEngineAttributed } from './run-record.mjs'

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
  const uncovered = {}
  const byDimension = {}
  const byEngine = {}
  let incompleteRuns = 0
  let uncoveredRuns = 0
  let unattributedRuns = 0

  for (const r of recs) {
    // WHICH ENGINE produced this run. Same stance as `worstVerdict` and `dim.ran === false`: what
    // cannot be told apart is not quietly assumed to be the same thing. A record with no
    // engineRevision gets its own `r?` bucket instead of joining the current engine's.
    const ek = engineKey(r)
    byEngine[ek] = (byEngine[ek] || 0) + 1
    if (!isEngineAttributed(r)) unattributedRuns++
    const name = r.name || '(unknown)'
    const w = byWorkflow[name] || (byWorkflow[name] = {
      runs: 0, block: 0, warning: 0, approve: 0, incomplete: 0, partialCoverage: 0,
      refuteRateSum: 0, refuteRateN: 0, candidates: 0, confirmed: 0, outputTokens: 0, outputTokensN: 0,
    })
    w.runs++
    const v = String(r.verdict || '')
    // The four per-workflow buckets are MUTUALLY EXCLUSIVE: every run increments AT MOST ONE, so
    // block+warning+approve+incomplete never exceeds `runs` (a verdict matching none of the patterns
    // increments none). The rule for a suffixed verdict is SEVERITY FIRST, then coverage:
    //   Block (INCOMPLETE)   -> block       — the block is a finding that was actually made; partial
    //                                         coverage cannot un-find it, and burying a block in the
    //                                         incomplete column would hide the worst runs.
    //   Warning (INCOMPLETE) -> warning     — same reasoning.
    //   Approve (INCOMPLETE) -> incomplete  — an approve is a claim about what was NOT found, which
    //                                         only holds over what was looked at. Partial coverage
    //                                         voids it, so it must not be counted as an approve.
    // `incompleteRuns` (top level) is the honest total of INCOMPLETE-suffixed runs and DOES overlap
    // the block/warning buckets; the per-workflow `incomplete` column is the exclusive bucket, i.e.
    // only the runs whose verdict is nothing but "incomplete".
    // Two DIFFERENT quantities, and the report must never spell them with the same word: the
    // overlapping "this run had partial coverage" total (a `Block (INCOMPLETE)` counts here AND in
    // the block bucket), and the exclusive bucket below. Ten `Block (INCOMPLETE)` runs once rendered
    // as "10 incomplete" in the header and `B/W/A 10/0/0` with no incomplete clause in the row.
    const incomplete = isIncomplete(v)
    if (incomplete) { incompleteRuns++; w.partialCoverage++ }
    if (/Block|At-risk|UB-found/i.test(v)) w.block++
    else if (/Warning|Concerns/i.test(v)) w.warning++
    else if (incomplete) w.incomplete++
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
    // Files no language profile covered are NOT a `notRun` entry and must never be folded into one:
    // `notRun` is ranked by exact string to surface REPEATED fragility, and a note embedding a count
    // and file names is unique per run — it filled the ranking with count-1 rows and sank the real
    // repeats. It is also the opposite claim: a notRun entry is fixable by re-running, an uncovered
    // file never will be. Rank the FILES instead, from the record's own `uncoveredFiles`.
    const uf = (Array.isArray(r.uncoveredFiles) ? r.uncoveredFiles : []).map(String).filter(Boolean)
    if (uf.length) {
      uncoveredRuns++
      for (const f of new Set(uf)) uncovered[f] = (uncovered[f] || 0) + 1
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
    partialCoverage: w.partialCoverage,
    avgRefuteRate: w.refuteRateN ? round2(w.refuteRateSum / w.refuteRateN) : null,
    candidates: w.candidates,
    confirmed: w.confirmed,
    avgOutputTokens: w.outputTokensN ? Math.round(w.outputTokens / w.outputTokensN) : null,
  })).sort((a, b) => b.runs - a.runs)

  const notRunRanked = Object.entries(notRun)
    .map(([item, count]) => ({ item, count }))
    .sort((a, b) => b.count - a.count || a.item.localeCompare(b.item))

  const uncoveredRanked = Object.entries(uncovered)
    .map(([file, count]) => ({ file, count }))
    .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))

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

  const engines = Object.entries(byEngine)
    .map(([engine, runs]) => ({ engine, runs }))
    .sort((a, b) => b.runs - a.runs || a.engine.localeCompare(b.engine))

  return {
    totalRuns: recs.length, incompleteRuns, uncoveredRuns, workflows,
    notRun: notRunRanked, uncoveredFiles: uncoveredRanked, dimensions,
    engines, unattributedRuns,
    // Every rate below (findings-per-run, refute, verdict mix) is an average over this record set.
    // It is a comparison of ONE engine only when the set holds one engine — and an unattributed
    // record is not evidence of belonging to any of them. `separable: false` is the aggregate
    // saying so about itself, so no caller can render it as a before/after by accident.
    separable: engines.length <= 1 && unattributedRuns === 0,
  }
}

// ---- CLI ----
// Returns {records, unreadable} — or null when the store directory does not exist.
// `unreadable` is load-bearing, not a diagnostic nicety: a record that fails to parse is a run whose
// telemetry is GONE, and silently dropping it makes the store look smaller rather than damaged. A
// 60-run store was found holding a 0-byte record (a write that died mid-flight); the count mismatch
// against the file listing was the only trace, and nothing in the report mentioned it.
// Split a record set into the runs that finished and the ones that died. Only the first set may be
// averaged: a partial run's missing lenses and unfinished verification are an outage, not a signal.
export function partitionByCompleteness(records) {
  const complete = [], partial = []
  for (const r of (Array.isArray(records) ? records : [])) {
    if (r && r.partial) partial.push(r)
    else if (r) complete.push(r)
  }
  return { complete, partial }
}

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

// The engine header. Three cases, and the difference between the last two is the point:
//   one engine, all attributed  → the rates below ARE a like-with-like comparison; say so.
//   several attributed engines  → a mix the reader can fix (filter with --engine).
//   any unattributed record     → a mix the reader CANNOT fix by filtering, because those records
//                                 do not say which engine ran. Not "probably the old one".
export function renderEngineSection(a) {
  const engines = Array.isArray(a.engines) ? a.engines : []
  const unattributed = Number(a.unattributedRuns) || 0
  if (a.separable && engines.length === 1) return [`_Engine: ${engines[0].engine} — all ${engines[0].runs} run(s). Rates below compare like with like._`]
  const L = [`## ⚠️ ENGINE BOUNDARY — this aggregate spans ${engines.length} engine build(s)`]
  L.push('_Every rate below is averaged ACROSS them. It is NOT a before/after measurement._')
  for (const e of engines) L.push(`- ${e.runs}× ${e.engine}`)
  if (unattributed) {
    L.push(`- ${unattributed} of those run(s) carry NO engineRevision: which engine produced them is unknown,`)
    L.push('  and a release version cannot decide it — one version can span a behaviour change.')
    L.push('  They are not assumed to be the current engine, and no filter can separate them.')
  }
  L.push('Slice with `--engine "<runtime> <version> r<N>"` (or `--engine latest`) to compare one engine.')
  return L
}

export function renderReport(a) {
  const L = [`# craft run analysis — ${a.totalRuns} run(s), ${a.incompleteRuns} with partial coverage`, '']
  // The engine boundary is stated BEFORE any number, not as a footnote after them: a reader who
  // has already read "findings/run 3.4" as a before/after has been misled, and a caveat underneath
  // does not take that back. Silence here is the whole defect — a mixed aggregate looks exactly
  // like a single-engine one.
  L.push(...renderEngineSection(a), '')
  L.push('## Workflows')
  for (const w of a.workflows) {
    L.push(`- ${w.name}: ${w.runs} run(s) · B/W/A ${w.verdicts.block}/${w.verdicts.warning}/${w.verdicts.approve}`
      + `${w.verdicts.incomplete ? ` · ${w.verdicts.incomplete} incomplete-only` : ''}`
      + `${w.partialCoverage ? ` · ${w.partialCoverage} partial coverage` : ''}`
      + `${w.avgRefuteRate != null ? ` · avg refute ${w.avgRefuteRate}` : ''}`
      + `${w.avgOutputTokens != null ? ` · ~${w.avgOutputTokens} out-tok/run` : ''}`)
  }
  L.push('', '## NOT RUN — fragility (highest first)')
  if (a.notRun.length) for (const n of a.notRun) L.push(`- ${n.count}× ${n.item}`)
  else L.push('- none')
  L.push('', `## NOT REVIEWED — files no language profile covered (${a.uncoveredRuns || 0} run(s))`)
  if (a.uncoveredFiles.length) for (const u of a.uncoveredFiles.slice(0, 20)) L.push(`- ${u.count}× ${u.file}`)
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
  // `--version <v>` / `--version latest` narrows the aggregate to one engine version. Mixing
  // versions is the default only because old records predate the field; any before/after question
  // ("did tightening that lens help?") needs this filter or the answer blends both rubrics.
  // `--engine <key>` is the SOUND slice, and `--version` is kept only because it is the older
  // spelling: a version filter narrows to a release, and a release can contain more than one
  // engine, so what it returns may still be a mix — the report says so when it is.
  let wantVersion = null
  let wantEngine = null
  const positional = []
  const rawArgs = process.argv.slice(2)
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i]
    if (a.startsWith('--version=')) { wantVersion = a.slice('--version='.length); continue }
    // Consume the VALUE too, or it is mistaken for the store directory.
    if (a === '--version') { wantVersion = rawArgs[++i] ?? 'latest'; continue }
    if (a.startsWith('--engine=')) { wantEngine = a.slice('--engine='.length); continue }
    if (a === '--engine') { wantEngine = rawArgs[++i] ?? 'latest'; continue }
    if (!a.startsWith('-')) positional.push(a)
  }
  const dir = positional[0] || path.join(os.homedir(), '.craft', 'runs')
  const loaded = loadRecords(dir)
  if (loaded === null) {
    console.log(`No run store at ${dir} — nothing to analyze yet. Run some reviews first.`)
    process.exit(0)
  }
  const { records, unreadable } = loaded
  // Records that parse but carry no schemaVersion are pre-telemetry runs — excluded from the
  // aggregate on purpose, but counted out loud so the report's run total is explainable.
  let usable = records.filter(r => r && r.schemaVersion)
  // A `partial: true` record is a run that DIED — recovered from phase checkpoints or rebuilt from a
  // transcript. It is exactly the run whose lenses never all reported and whose verification never
  // finished, so averaging it in would depress every yield and refute rate with an artefact of the
  // outage rather than of the rubric. Excluded from the aggregate, but never silently: the whole
  // reason these records exist is that a dead run used to leave no trace at all.
  const split = partitionByCompleteness(usable)
  const partials = split.partial
  usable = split.complete
  const versions = [...new Set(usable.map(r => r.craftVersion).filter(Boolean))].sort()
  let versionNote = ''
  if (wantEngine) {
    // `latest` is the engine of the NEWEST run, not the highest version string: version strings do
    // not order engines (0.16.0 held two), and the newest record is a fact rather than a guess.
    const newest = usable.reduce((best, r) => (!best || String(r.ts) > String(best.ts) ? r : best), null)
    const target = wantEngine === 'latest' ? (newest ? engineKey(newest) : '') : wantEngine
    if (!target) {
      console.log('No runs to pick an engine from.')
      process.exit(0)
    }
    const before = usable.length
    usable = usable.filter(r => engineKey(r) === target)
    if (!usable.length) {
      const seen = [...new Set(records.filter(r => r && r.schemaVersion).map(engineKey))].sort()
      console.log(`No run matches engine "${target}". Engines in this store:\n${seen.map(s => `- ${s}`).join('\n')}`)
      process.exit(0)
    }
    versionNote = `\n_Filtered to engine ${target}: ${usable.length} of ${before} run(s)._`
  } else if (wantVersion) {
    const target = wantVersion === 'latest' ? versions[versions.length - 1] : wantVersion
    if (!target) {
      console.log('No run carries a craftVersion yet — nothing to filter on. Showing everything.')
    } else {
      const before = usable.length
      usable = usable.filter(r => r.craftVersion === target)
      // A version filter is NOT an engine filter. It narrows to a release, and a release can hold
      // more than one engine — 0.16.0 did. Whether what came back is one engine is decided by the
      // ENGINE BOUNDARY section the report prints above these numbers, not by this line.
      versionNote = `\n_Filtered to craft ${target}: ${usable.length} of ${before} run(s). A version is not an engine — see the engine header above._`
    }
  }
  // The old "this store mixes N craft versions" note is gone on purpose: the ENGINE BOUNDARY
  // section states the same thing more precisely (and states the case the version note could not
  // see — one version, two engines), and it states it before the numbers rather than after.
  console.log(renderReport(aggregate(usable)) + versionNote)
  const legacy = records.length - usable.length - partials.length
  if (legacy) console.log(`\n_${legacy} record(s) skipped: no schemaVersion (pre-telemetry runs)._`)
  if (partials.length) {
    console.log(`\n## ⚠️ Runs that did not finish — ${partials.length}`)
    console.log('_Excluded from every rate above; they are outages, not rubric signal._')
    for (const p of partials) {
      const s = p.runtimeStats
      const cost = s ? ` · ${s.agents} agent(s), ${s.wallClockMinutes}min wall${s.longestStallSeconds > 600 ? `, longest single-agent stall ${Math.round(s.longestStallSeconds / 60)}min` : ''}` : ''
      console.log(`- ${p.ts} ${p.name} — ${p.partialReason || 'incomplete'}${cost}`)
    }
  }
  if (unreadable.length) {
    console.log(`\n## ⚠️ Unreadable records — ${unreadable.length} run(s) of telemetry lost`)
    for (const u of unreadable) console.log(`- ${u.file} — ${u.reason}`)
  }
}
