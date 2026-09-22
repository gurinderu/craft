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

// What a refute denominator MEANS, from a count of the rows that carry the unverified tier
// (`tracked`) and the rows that predate it (`legacy`). One helper because there are two levels with
// the same problem — the per-lens denominator and the run-level `verification.candidates` — and a
// second hand-written ternary is how the levels drift apart.
// `null` for zero rows on purpose: `legacy` is an assertion about a measurement ("unjudged items are
// inside this rate"), and with nothing measured there is nothing to assert. The chain used to fall
// through to `legacy` there, so a dimension whose every lens died printed a basis caveat for a rate
// it did not have.
function basisOf(tracked, legacy) {
  if (!tracked && !legacy) return null
  return tracked && legacy ? 'mixed' : tracked ? 'strict' : 'legacy'
}

// Pure: array of parsed run records → structured summary. Tolerant of malformed / partial records.
export function aggregate(records) {
  const recs = (Array.isArray(records) ? records : []).filter(r => r && typeof r === 'object')
  const byWorkflow = {}
  const notRun = {}
  // The deliberate verification savings, ranked APART from the failures in `notRun`. Both describe
  // a verification that did not happen, and that is exactly why they must not share a list: a
  // `notRun` entry is fragility a re-run fixes, a saving is a decision a re-run will make again.
  // Counted here so the economy has a reader at all — a saving nobody can count is indistinguishable
  // from a saving nobody made.
  const savedByFloor = {}
  // Runs where the saving's premise did not survive to the verdict: the skip was made because the
  // verdict stood at Block, and the run then ended somewhere else. Those findings are unverified for
  // no good reason, and the engine converts them into `notRun` — so this counts the EVENT, which is
  // what says whether the economy is sound, not merely how often it fires.
  let savedByFloorRevokedRuns = 0
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
      refuteRateSum: 0, refuteRateN: 0, candidates: 0, confirmed: 0,
      // `outputTokens` is budget.spent() — the whole-run token POOL (input + output + parent-driver
      // + cache), NOT output tokens — and its size is set by run TYPE: a re-review (round > 1) runs
      // an extra Adjudicate phase and a whole-diff re-scan, so its pool is structurally MUCH larger
      // than a first-pass's (round 1). Averaging the two under one name is the same anti-pattern the
      // file already guards (refuteTracked/Legacy, thinned/thinnedMeasured): what cannot be told
      // apart is not quietly assumed to be one number. So the pool is split by round and reported as
      // two metrics, each named as a POOL. A record with no round (pre-round or a recovered run) is
      // read as first-pass, never invented as a re-review — the `savedByFloorPremiseHeld === false`
      // stance, one field over.
      poolFirstPass: 0, poolFirstPassN: 0, poolReReview: 0, poolReReviewN: 0,
      // The RUN-level twin of the per-dimension `tracked`/`legacy` tally. `verification.candidates`
      // changed meaning exactly as the per-lens denominator did — the engine now excludes the
      // candidates no verifier judged — under the same field name and the same `schemaVersion`. Only
      // the dimension row got a basis, so `avg refute` averaged two different quantities with
      // nothing saying so. The discriminator is the presence of `verification.unverified`, which
      // only a run written after the tier carries.
      refuteTracked: 0, refuteLegacy: 0,
      // PANELS THAT HALF-DIED. `verification.thinned` counts the findings whose verdict was reached
      // after at least one returned vote was discarded as off-schema. The engine writes it so that
      // repeated thinning is legible as a REPEAT — fragility is only visible across runs — and that
      // claim holds only if a reader aggregates it, which is here. Not in `indexProjection`: the
      // projection is mirrored verbatim into workflow scripts that stamp no such field, and this
      // reader loads the detail records, where the field always is.
      // `thinnedMeasured` is the DISCRIMINATOR, and it is why the two are counted separately: only
      // `review` stamps `thinned`. For every other engine the field is simply absent, and an absent
      // field rendered the same way a zero does — as no clause at all — so the report said "no
      // thinning here" where the truth is "nothing measured it". The counter of runs that CARRIED
      // the field is what tells those two apart, and the row below prints the difference.
      thinned: 0, thinnedRuns: 0, thinnedMeasured: 0,
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
      if (typeof ver.refuteRate === 'number') {
        w.refuteRateSum += ver.refuteRate; w.refuteRateN++
        if (typeof ver.unverified === 'number') w.refuteTracked++
        else w.refuteLegacy++
      }
      if (typeof ver.thinned === 'number') { w.thinnedMeasured++; if (ver.thinned > 0) { w.thinned += ver.thinned; w.thinnedRuns++ } }
      if (typeof ver.candidates === 'number') w.candidates += ver.candidates
      if (typeof ver.confirmed === 'number') w.confirmed += ver.confirmed
    }
    // round > 1 → re-review pool; round === 1, or absent/0 (a recovered run), → first-pass. `undefined
    // > 1` is false, so an absent round falls to first-pass with no special case.
    if (typeof r.outputTokens === 'number') {
      if (r.round > 1) { w.poolReReview += r.outputTokens; w.poolReReviewN++ }
      else { w.poolFirstPass += r.outputTokens; w.poolFirstPassN++ }
    }

    for (const item of (Array.isArray(r.savedByFloor) ? r.savedByFloor : [])) {
      const k = String(item)
      savedByFloor[k] = (savedByFloor[k] || 0) + 1
    }
    // Explicitly `=== false`, never falsy: a record written before this field existed has it
    // `undefined`, and reading that as "the premise was revoked" would invent a defect in every
    // historical run.
    if (r.savedByFloorPremiseHeld === false) savedByFloorRevokedRuns++

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
      const agg = byDimension[k] || (byDimension[k] = { runs: 0, dead: 0, findings: 0, confirmed: 0, suspected: 0, refuted: 0, unverified: 0, tracked: 0, legacy: 0, bySeverity: { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 } })
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
      // `unverifiedCount` — the tier for a candidate no verifier ever judged (an unchecked Low/Info
      // the engine deliberately spends no verifier on). It is READ here rather than ignored, and it
      // stays OUT of the refute denominator below, matching what the engine already does at the run
      // level (`verification.candidates` = deduped − unverified).
      //
      // But that changed the MEANING of the dimension-level denominator without changing the field
      // name or `schemaVersion`: before the unverified tier existed, those same unjudged items were
      // filed under `suspectedCount`, so they WERE in the denominator. A store holding runs from
      // both sides therefore holds two different `refuteRate`s under one name, and nothing in the
      // record says which. Since the records cannot be re-labelled after the fact, the report says
      // it instead: a dimension row counts how many of its contributing lens rows carry the field
      // (`tracked`) and how many predate it (`legacy`), and `refuteBasis` below names the mix.
      if (typeof dim.unverifiedCount === 'number') {
        agg.tracked++
        agg.unverified += Number(dim.unverifiedCount) || 0
      } else {
        agg.legacy++
      }
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
    // What `avgRefuteRate` above is an average OVER. `null` when no run contributed a rate at all:
    // a basis is a claim about a measurement, and over zero rows there is no measurement to qualify.
    refuteBasis: basisOf(w.refuteTracked, w.refuteLegacy),
    candidates: w.candidates,
    confirmed: w.confirmed,
    thinned: w.thinned,
    thinnedRuns: w.thinnedRuns,
    thinnedMeasured: w.thinnedMeasured,
    // The run-token pool, split by run type. Two averages, never one: a re-review pool and a
    // first-pass pool are not the same quantity, and a blended figure is neither.
    avgRunTokenPoolFirstPass: w.poolFirstPassN ? Math.round(w.poolFirstPass / w.poolFirstPassN) : null,
    avgRunTokenPoolReReview: w.poolReReviewN ? Math.round(w.poolReReview / w.poolReReviewN) : null,
  })).sort((a, b) => b.runs - a.runs)

  const notRunRanked = Object.entries(notRun)
    .map(([item, count]) => ({ item, count }))
    .sort((a, b) => b.count - a.count || a.item.localeCompare(b.item))

  const savedByFloorRanked = Object.entries(savedByFloor)
    .map(([item, count]) => ({ item, count }))
    .sort((a, b) => b.count - a.count || a.item.localeCompare(b.item))

  const uncoveredRanked = Object.entries(uncovered)
    .map(([file, count]) => ({ file, count }))
    .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))

  const dimensions = Object.entries(byDimension).map(([dimension, d]) => {
    const candidates = d.confirmed + d.suspected + d.refuted
    return {
      dimension, runs: d.runs, dead: d.dead, findings: d.findings, bySeverity: d.bySeverity,
      confirmed: d.confirmed, suspected: d.suspected, refuted: d.refuted, candidates,
      findingsPerRun: d.runs ? round2(d.findings / d.runs) : 0,
      // Unjudged candidates, counted and reported BESIDE the rate rather than inside it.
      unverified: d.unverified,
      // What the denominator above actually means for this row. `strict`: every contributing lens
      // row carried `unverifiedCount`, so unjudged items are excluded throughout. `legacy`: none
      // did, so unjudged items are folded into `suspected` and the rate is over a wider base.
      // `mixed`: both, and the rate is not a like-for-like comparison at all. `null`: NO contributing
      // row at all — every planned lens row was `ran: false`, so there is nothing to state a basis
      // about. That case used to fall through the ternary chain to `legacy` and print "unjudged items
      // are inside this denominator" over zero measured rows, which is a claim, not an absence.
      // The report prints this whenever it is not `strict`, because no reader can recover it from
      // the records.
      refuteBasis: basisOf(d.tracked, d.legacy),
      // null (not 0) when there is no per-lens verification data, so old runs don't read as "0% refute".
      refuteRate: candidates ? round2(d.refuted / candidates) : null,
    }
  }).sort((a, b) => b.findings - a.findings || a.dimension.localeCompare(b.dimension))

  const engines = Object.entries(byEngine)
    .map(([engine, runs]) => ({ engine, runs }))
    .sort((a, b) => b.runs - a.runs || a.engine.localeCompare(b.engine))

  return {
    totalRuns: recs.length, incompleteRuns, uncoveredRuns, workflows,
    notRun: notRunRanked, savedByFloor: savedByFloorRanked, savedByFloorRevokedRuns,
    uncoveredFiles: uncoveredRanked, dimensions,
    engines, unattributedRuns,
    // Every rate below (findings-per-run, refute, verdict mix) is an average over this record set.
    // It is a comparison of ONE engine only when the set holds one engine — and an unattributed
    // record is not evidence of belonging to any of them. `separable: false` is the aggregate
    // saying so about itself, so no caller can render it as a before/after by accident.
    // It is a claim about SOUNDNESS, not a render switch: `renderEngineSection` keys the boundary
    // banner off `engines.length` and `unattributedRuns` separately, because a store of one
    // unattributed bucket is `separable: false` (we cannot prove one build wrote it) while nothing
    // in it is being blended — and rendering the cross-engine banner there was a false alarm.
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

// The engine header. TWO INDEPENDENT conditions, and conflating them was the defect: "this
// aggregate spans more than one engine build" and "some records do not say which build wrote them"
// are different claims, and only the first makes the numbers below a cross-engine blend. The banner
// once fired on a store holding ONE bucket — which is every OpenCode store and every pre-change
// store, since neither stamps a revision — and announced that it "spans 1 engine build(s)" whose
// rates were averaged "ACROSS them". A warning that fires on runs that were fine is not a safe
// error: it teaches the reader to skip the section, and then it is skipped on the run that mattered.
//   no runs                     → nothing to attribute; say that and stop.
//   one bucket, all attributed  → the rates ARE a like-with-like comparison; say so.
//   one bucket, none attributed → still one bucket, so nothing is being blended HERE. What is
//                                 unknown is whether that bucket is one BUILD, since a record with
//                                 no revision cannot say. A note, not a boundary.
//   several buckets             → the boundary: every rate below is averaged across them.
// The unattributed records are separately filterable — `engineKey` is deterministic, so
// `--engine "<runtime> <version> r?"` selects exactly them. What filtering cannot do is make that
// slice ONE engine, and that is what the note says instead of the old (false) "no filter can
// separate them".
export function renderEngineSection(a) {
  const engines = Array.isArray(a.engines) ? a.engines : []
  const unattributed = Number(a.unattributedRuns) || 0
  if (!engines.length) return ['_No runs to attribute to an engine._']
  if (engines.length === 1) {
    const e = engines[0]
    if (!unattributed) return [`_Engine: ${e.engine} — all ${e.runs} run(s). Rates below compare like with like._`]
    return [
      `_Engine: ${e.engine} — all ${e.runs} run(s), none of which carries an engineRevision._`,
      '_One bucket, so nothing is blended here — but without a revision these records cannot say_',
      '_whether one engine build wrote them all. Read the rates as a before/after only if you know_',
      '_the engine did not change across them._',
    ]
  }
  const L = [`## ⚠️ ENGINE BOUNDARY — this aggregate spans ${engines.length} engine build(s)`]
  L.push('_Every rate below is averaged ACROSS them. It is NOT a before/after measurement._')
  for (const e of engines) L.push(`- ${e.runs}× ${e.engine}`)
  if (unattributed) {
    L.push(`- ${unattributed} of those run(s) carry NO engineRevision: which engine produced them is unknown,`)
    L.push('  and a release version cannot decide it — one version can span a behaviour change.')
    L.push('  They are not assumed to be the current engine. `--engine "<runtime> <version> r?"` selects')
    L.push('  exactly them, but that slice is still not known to be a single engine build.')
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
      // Same rule as the dimension row: printed only when it is NOT `strict`, and never over a
      // rate that does not exist. The run-level denominator changed meaning exactly as the per-lens
      // one did, so an unqualified average here is the same silence, one level up.
      + `${w.avgRefuteRate != null && w.refuteBasis === 'mixed' ? ' · ⚠️ refute basis MIXED — some runs predate the unverified tier and count unjudged candidates inside the denominator' : ''}`
      + `${w.avgRefuteRate != null && w.refuteBasis === 'legacy' ? ' · ⚠️ refute basis LEGACY — unjudged candidates are inside this denominator' : ''}`
      + `${w.thinned ? ` · ⚠️ ${w.thinned} verdict(s) on a THINNED panel across ${w.thinnedRuns} run(s) — votes answered off-schema and were discarded before the arithmetic${w.thinnedMeasured < w.runs ? ` (thinning measured on ${w.thinnedMeasured}/${w.runs} run(s))` : ''}` : ''}`
      // NOT MEASURED IS NOT ZERO. Only `review` stamps `verification.thinned`; for another engine the
      // clause above is absent for want of a measurement, which reads exactly like a clean panel. Say
      // which it is instead of leaving the reader to guess from a missing clause.
      + `${!w.thinned && !w.thinnedMeasured ? ` · thinning NOT MEASURED — none of these runs carried \`thinned\`, so the absence above is not "no thinning"` : ''}`
      + `${!w.thinned && w.thinnedMeasured && w.thinnedMeasured < w.runs ? ` · thinning measured on ${w.thinnedMeasured}/${w.runs} run(s), none thinned` : ''}`
      // Named as a POOL, split by run type — never "output". A re-review pool is structurally larger
      // than a first-pass pool, so the two are printed apart and must not be compared across types.
      + `${w.avgRunTokenPoolFirstPass != null ? ` · ~${w.avgRunTokenPoolFirstPass} tok-pool/run (first-pass)` : ''}`
      + `${w.avgRunTokenPoolReReview != null ? ` · ~${w.avgRunTokenPoolReReview} tok-pool/run (re-review)` : ''}`)
  }
  L.push('', '## NOT RUN — fragility (highest first)')
  if (a.notRun.length) for (const n of a.notRun) L.push(`- ${n.count}× ${n.item}`)
  else L.push('- none')
  // PRINTED SEPARATELY FROM THE FRAGILITY LIST ABOVE, and printed even when empty. These two
  // sections describe the same event — a verification that did not happen — and mean opposite
  // things: one is fragility a re-run fixes, the other a decision a re-run repeats. Merged, the
  // savings would bury the repeats. Absent, the economy would be unobservable through the only tool
  // that reads the store, and an economy nobody can count is indistinguishable from one nobody made.
  L.push('', '## SAVED — verifications deliberately not bought (highest first)')
  if (a.savedByFloor.length) for (const n of a.savedByFloor.slice(0, 20)) L.push(`- ${n.count}× ${n.item}`)
  else L.push('- none')
  // The soundness signal, and the reason the section above is not simply good news. A skip is
  // justified by a verdict that had not been decided yet; when that verdict fails to arrive the
  // findings were dropped for a reason that did not apply. This counts those runs. Stated as a
  // presence AND as an absence: silence here would read as "never happened" when it can equally
  // mean "written before the field existed".
  L.push(a.savedByFloorRevokedRuns
    ? `- ⚠️ ${a.savedByFloorRevokedRuns} run(s) where the PREMISE DID NOT HOLD — the verdict those skips were justified by never arrived, so the findings went unverified for no reason; the engine reports those runs INCOMPLETE`
    : `- premise held on every run that carries the field (a run written before it reads as silence, not as a held premise)`)
  L.push('', `## NOT REVIEWED — files no language profile covered (${a.uncoveredRuns || 0} run(s))`)
  if (a.uncoveredFiles.length) for (const u of a.uncoveredFiles.slice(0, 20)) L.push(`- ${u.count}× ${u.file}`)
  else L.push('- none')
  L.push('', '## Dimensions — confirmed findings (highest first)')
  if (a.dimensions.length) for (const d of a.dimensions) {
    const sev = SEVERITIES.filter(s => d.bySeverity[s]).map(s => `${s[0]}${d.bySeverity[s]}`).join(' ') || '—'
    L.push(`- ${d.dimension}: ${d.findings} finding(s) / ${d.runs} run(s) (${d.findingsPerRun}/run) · ${sev}`
      + `${d.refuteRate != null ? ` · refute ${d.refuteRate} (${d.refuted}/${d.candidates})` : ''}`
      + `${d.unverified ? ` · ${d.unverified} unverified (outside the rate)` : ''}`
      // Only when it is NOT `strict`: a caveat on every row is a caveat nobody reads.
      + `${d.refuteBasis === 'mixed' ? ' · ⚠️ refute basis MIXED — some rows predate the unverified tier and count unjudged items as suspected' : ''}`
      + `${d.refuteBasis === 'legacy' && d.refuteRate != null ? ' · ⚠️ refute basis LEGACY — unjudged items are inside this denominator' : ''}`
      + `${d.dead ? ` · ⚠️ ${d.dead} run(s) it never returned` : ''}`)
  } else L.push('- none')
  L.push('', `## NOISE — lenses over-refuting (refute ≥ ${MIN_REFUTE_RATE}, ≥${MIN_REFUTE_CANDIDATES} candidates)`)
  const rated = a.dimensions.filter(d => d.refuteRate != null && d.candidates >= MIN_REFUTE_CANDIDATES)
  const noisy = rated
    .filter(d => d.refuteRate >= MIN_REFUTE_RATE)
    .sort((x, y) => y.refuteRate - x.refuteRate || y.candidates - x.candidates)
  // This is the section that PROMPTS AN ACTION, so it is the one place the basis may least be left
  // out: a legacy or mixed denominator inflates the rate (unjudged candidates sit inside it), and a
  // reader acting on the number tightens a rubric over a rate that was never like-for-like. The
  // Dimensions section above states it, but nobody reads two sections to act on one.
  if (noisy.length) for (const d of noisy) {
    const basis = d.refuteBasis === 'mixed'
      ? ' · ⚠️ refute basis MIXED — some rows predate the unverified tier, so this rate is not like-for-like; confirm before tightening'
      : d.refuteBasis === 'legacy'
        ? ' · ⚠️ refute basis LEGACY — unjudged candidates are inside this denominator, which inflates the rate; confirm before tightening'
        : ''
    L.push(`- ${d.dimension}: refute ${d.refuteRate} (${d.refuted}/${d.candidates}) · ${d.confirmed} confirmed — tighten this lens's rubric${basis}`)
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
