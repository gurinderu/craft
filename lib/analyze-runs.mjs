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
import { engineKey, engineRevisionToken, isEngineAttributed } from './run-record.mjs'

export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info']

const round2 = n => Math.round(n * 100) / 100
const isIncomplete = v => /INCOMPLETE/i.test(String(v || ''))
// The revision token engineKey uses, off one record: `r<N>` for an attributed run, `r?` for one with
// no engineRevision. The SAME helper `engineKey` uses (lib/run-record.mjs), imported so the collision
// buckets never drift from the engine buckets — if the token shape changes, both move together.
// (realm @nick/craft, #95)
const revToken = engineRevisionToken
// Order revision tokens for display: by revision number, with the unknown `r?` last.
const revOrder = (a, b) => (a === 'r?' ? Infinity : Number(a.slice(1))) - (b === 'r?' ? Infinity : Number(b.slice(1)))
// Order version strings by SEMVER, not lexicographically: '0.9.0' precedes '0.10.0' and '0.18.1',
// where `localeCompare` puts '0.10.0' and '0.18.1' first. Compare segment by segment as numbers;
// fall back to a string compare on any segment that is not numeric on both sides (a prerelease tag,
// a malformed version), so the order stays total and never throws. A missing segment reads as 0
// ('0.9' and '0.9.0' order equal). Display order only — collision DETECTION is `revs.size > 1`.
const compareSemver = (a, b) => {
  const pa = String(a).split('.')
  const pb = String(b).split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const sa = pa[i] ?? '', sb = pb[i] ?? ''
    const na = Number(sa), nb = Number(sb)
    if (Number.isFinite(na) && Number.isFinite(nb)) { if (na !== nb) return na - nb }
    else if (sa !== sb) return sa < sb ? -1 : 1
  }
  return 0
}
// The colliding versions only — a craftVersion carried by more than one distinct revision token. A
// reader slicing by that version blends two different engines; the report and the `--version` filter
// both surface this so the trap is visible. Revisions within a version order by `revOrder` (r? last);
// the versions order by SEMVER. Pulled out of `aggregate` so that function does not accrete this
// concern — behavior is identical. (realm @nick/craft, #95)
const collectVersionCollisions = revsByVersion => Object.entries(revsByVersion)
  .filter(([, revs]) => revs.size > 1)
  .map(([version, revs]) => ({ version, revisions: [...revs].sort(revOrder) }))
  .sort((a, b) => compareSemver(a.version, b.version))
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

// Add one run's token pool to the matching bucket, classified by the PRESENCE and value of `round`:
// a number > 1 → re-review; a number <= 1 (0 or 1) → first-pass; NOT a number (absent) →
// Unclassified, never silently first-pass. The discriminator is `typeof r.round === 'number'`, not
// `r.round > 1`: `undefined > 1` is false and would sweep every round-less run into first-pass. A run
// with no numeric `outputTokens` contributes to no pool. Extracted from the record loop so the
// three-way tally reads apart from the rest of aggregate.
function tallyPool(w, r) {
  if (typeof r.outputTokens !== 'number') return
  if (typeof r.round === 'number' && r.round > 1) { w.poolReReview += r.outputTokens; w.poolReReviewN++ }
  else if (typeof r.round === 'number') { w.poolFirstPass += r.outputTokens; w.poolFirstPassN++ }
  else { w.poolUnclassified += r.outputTokens; w.poolUnclassifiedN++ }
}

// Fold one run's REAL cost into the workflow bucket, when it was enriched. `outputTokens` (tallyPool
// above) is `budget.spent()` — the harness pool, under 1% of real spend; the record's `cost` object
// carries the other ~99% (cache_read/cache_write), summed post-hoc from the per-agent transcripts by
// `craft-log-run enrich-cost`. A record with no `cost` was never enriched: it contributes nothing and
// does NOT count as a zero-cost run — an un-enriched record is silent about cost, not evidence of a
// free run, the same "NOT MEASURED IS NOT ZERO" stance the pool split already takes. `costRuns` is
// the denominator that keeps the two apart. `total` is trusted when present and numeric, else
// recomputed from the four parts so a record enriched by an older writer still contributes a figure.
function tallyCost(w, r) {
  const c = r.cost
  if (!c || typeof c !== 'object') return
  const read = Number(c.cacheRead) || 0
  const write = Number(c.cacheWrite) || 0
  const inp = Number(c.input) || 0
  const outp = Number(c.output) || 0
  w.costRuns++
  w.costCacheRead += read
  w.costCacheWrite += write
  w.costInput += inp
  w.costOutput += outp
  w.costTotal += Number.isFinite(Number(c.total)) ? Number(c.total) : read + write + inp + outp
}

// Fold one run's surface-gate outcome into its workflow bucket. THREE populations, kept apart —
// the same "absence is not a measurement" discipline `thinnedMeasured` already applies one field
// over:
//   - no `surfaceGate` object at all -> NO GATE RECORD. Either the field did not exist when this run
//     was recorded, or this engine/path never writes it — a current-engine early exit (empty diff,
//     nothing to review) returns before the record writer, so absence is NOT proof the run predates
//     the gate. Either way it must not be read as "the gate ran and saved nothing", which would
//     invent a measurement the run never made. Counted in `sgPreGate`, never folded into the saved
//     tally below.
//   - `surfaceGate` present, `dropped` empty -> the gate ran and found nothing to drop this run.
//     Counted in `sgGateRuns` only.
//   - `surfaceGate.dropped` non-empty -> the gate saved that many whole-repo passes this run.
//     Counted in `sgSavedRuns`/`sgSavedPasses`/`sgSavedByLens`.
//
// A FOURTH population, for the SHARE (saved / (saved + dispatched)): `surfaceGate.dispatched`
// (realm @nick/craft #102 follow-up) is the gateable lenses that actually ran, read straight off
// review.js's module-level dispatch-point Set — the same reliable source `dropped` is already
// subtracted against. A run recorded BEFORE this field existed carries the gate but has no
// `dispatched` array at all; reading that as `dispatched: []` would credit it as a zero-cost
// denominator while its `dropped` count still swells the numerator, inflating the share with a run
// the share cannot actually see. So a run missing the field contributes to NEITHER
// `sgShareSavedPasses` NOR `sgDispatchedPasses` — only to `sgMissingDispatchedRuns`, reported apart
// so the gap is visible rather than silently zero-filled (the same NOT-MEASURED-IS-NOT-ZERO stance
// `sgPreGate` already takes one field over). `sgSavedPasses` itself is untouched by this — it stays
// the full, wide count over every gate-present run, exactly as before.
function tallySurfaceGate(w, r) {
  const sg = r.surfaceGate
  if (!sg || typeof sg !== 'object') { w.sgPreGate++; return }
  w.sgGateRuns++
  const dropped = Array.isArray(sg.dropped) ? sg.dropped.map(String) : []
  const dispatched = Array.isArray(sg.dispatched) ? sg.dispatched : null
  // A mechanically gate-failed run aborts before any lens dispatches, so its planning-time drops were
  // never in play — fictional savings. But a healthy run that gated every gateable lens (gate passed,
  // dispatched empty) is a real 100% saving, and a multi-profile run where one profile failed but
  // another dispatched (dispatched non-empty) did real work — gate.status alone must not exclude those.
  // Exclude ONLY the conjunction: gate failed AND nothing dispatched.
  if (r.gate && r.gate.status === 'fail' && dispatched && dispatched.length === 0) { w.sgGateFailedRuns++; return }
  if (dropped.length) w.sgSavedRuns++
  w.sgSavedPasses += dropped.length
  for (const lens of dropped) w.sgSavedByLens[lens] = (w.sgSavedByLens[lens] || 0) + 1
  if (dispatched) {
    w.sgShareSavedPasses += dropped.length
    w.sgDispatchedPasses += dispatched.length
  } else {
    w.sgMissingDispatchedRuns++
  }
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
  // craftVersion -> set of distinct revision tokens carrying it. A version string names a RELEASE,
  // not an engine (release-please bumps it only when it cuts a release, so trunk keeps the last
  // release's version across byte-diverged engines), so one craftVersion can carry more than one
  // engineRevision. The `--version` filter and the default report cannot see that; this makes it
  // visible. (realm @nick/craft, #95)
  const revsByVersion = {}
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
    // Track which revisions each craftVersion carries, to detect a version string that spans more
    // than one engine. Records with no craftVersion (opencode is unversioned) have no version string
    // to collide, so they do not participate. (realm @nick/craft, #95)
    if (r.craftVersion) (revsByVersion[r.craftVersion] || (revsByVersion[r.craftVersion] = new Set())).add(revToken(r))
    const name = r.name || '(unknown)'
    const w = byWorkflow[name] || (byWorkflow[name] = {
      runs: 0, block: 0, warning: 0, approve: 0, incomplete: 0, partialCoverage: 0,
      refuteRateSum: 0, refuteRateN: 0, candidates: 0, confirmed: 0,
      // `outputTokens` is budget.spent() — the whole-run token POOL (input + output + parent-driver
      // + cache), NOT output tokens — and its size is set by run TYPE: a re-review (round > 1) runs
      // an extra Adjudicate phase (and periodically a whole-diff re-scan), so its pool is structurally MUCH larger
      // than a first-pass's (round <= 1). Averaging the two under one name is the same anti-pattern
      // the file already guards (refuteTracked/Legacy, thinned/thinnedMeasured): what cannot be told
      // apart is not quietly assumed to be one number. So the pool is split THREE ways, keyed on the
      // PRESENCE and value of `round`, never two — because an ABSENT round is a third state, not a
      // first-pass. Only `review` stamps `round`; `adversarial-review`, `rust-audit` and
      // `triage-findings` write `outputTokens` with none. And a round-less `review` run is not always
      // historical: `review` has several current early-exit paths that write `outputTokens` with no
      // `round` at all. The analyzer cannot know which cause put a run in the round-less pool, so it
      // asserts none. Reading an absent round as first-pass would fold structurally-different totals
      // into the first-pass average unwarned (the same "NOT MEASURED IS NOT ZERO" defect the thinned
      // clause guards). So a round-less run goes to its OWN `Unclassified` pool — never invented as
      // first-pass or re-review, the `savedByFloorPremiseHeld === false` stance, one field over.
      poolFirstPass: 0, poolFirstPassN: 0, poolReReview: 0, poolReReviewN: 0,
      poolUnclassified: 0, poolUnclassifiedN: 0,
      // REAL cost, from records enriched post-hoc by `craft-log-run enrich-cost` (see tallyCost).
      // Counted apart from the pool above: the pool is the harness's <1%, this is the ~99% that lives
      // only in the per-agent transcripts. `costRuns` keeps un-enriched runs from reading as zero.
      costRuns: 0, costCacheRead: 0, costCacheWrite: 0, costInput: 0, costOutput: 0, costTotal: 0,
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
      // The surface gate's saving (realm @nick/craft #102) — see tallySurfaceGate for what each
      // counts. `sgSavedByLens` rides as a plain object (not a Map) so it survives untouched into
      // the returned aggregate, matching `bySeverity` on the dimension rows below.
      sgPreGate: 0, sgGateRuns: 0, sgGateFailedRuns: 0, sgSavedRuns: 0, sgSavedPasses: 0, sgSavedByLens: {},
      // The SHARE population (see tallySurfaceGate): scoped to runs that carry `dispatched`, so the
      // share's numerator and denominator are drawn from the same runs, never a mix of measured and
      // assumed. `sgMissingDispatchedRuns` counts what that scoping leaves out.
      sgDispatchedPasses: 0, sgShareSavedPasses: 0, sgMissingDispatchedRuns: 0,
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
    tallyPool(w, r)
    tallyCost(w, r)
    tallySurfaceGate(w, r)

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
    // The run-token pool, split three ways by run type. Never one blended figure: a re-review pool,
    // a first-pass pool and a round-less (Unclassified) pool are not the same quantity. The
    // Unclassified sample size rides along so the render can name those runs as counted apart from
    // the split rather than fold them into first-pass.
    avgRunTokenPoolFirstPass: w.poolFirstPassN ? Math.round(w.poolFirstPass / w.poolFirstPassN) : null,
    avgRunTokenPoolReReview: w.poolReReviewN ? Math.round(w.poolReReview / w.poolReReviewN) : null,
    avgRunTokenPoolUnclassified: w.poolUnclassifiedN ? Math.round(w.poolUnclassified / w.poolUnclassifiedN) : null,
    poolUnclassifiedN: w.poolUnclassifiedN,
    // The REAL per-run cost, averaged over the enriched runs only. `null` when no run carried a
    // `cost` object — a workflow with nothing enriched states no cost, rather than a cost of zero.
    // cacheRead is surfaced first because it IS the spend (~99%); the pool figures above are <1%.
    costRuns: w.costRuns,
    avgCacheReadPerRun: w.costRuns ? Math.round(w.costCacheRead / w.costRuns) : null,
    avgCacheWritePerRun: w.costRuns ? Math.round(w.costCacheWrite / w.costRuns) : null,
    avgCostInputPerRun: w.costRuns ? Math.round(w.costInput / w.costRuns) : null,
    avgCostOutputPerRun: w.costRuns ? Math.round(w.costOutput / w.costRuns) : null,
    avgCostTotalPerRun: w.costRuns ? Math.round(w.costTotal / w.costRuns) : null,
    // The surface gate's saving, carried through unchanged from the tally — see tallySurfaceGate.
    sgPreGate: w.sgPreGate, sgGateRuns: w.sgGateRuns, sgGateFailedRuns: w.sgGateFailedRuns, sgSavedRuns: w.sgSavedRuns,
    sgSavedPasses: w.sgSavedPasses, sgSavedByLens: w.sgSavedByLens,
    sgDispatchedPasses: w.sgDispatchedPasses, sgShareSavedPasses: w.sgShareSavedPasses,
    sgMissingDispatchedRuns: w.sgMissingDispatchedRuns,
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

  const versionCollisions = collectVersionCollisions(revsByVersion)

  return {
    totalRuns: recs.length, incompleteRuns, uncoveredRuns, workflows,
    notRun: notRunRanked, savedByFloor: savedByFloorRanked, savedByFloorRevokedRuns,
    uncoveredFiles: uncoveredRanked, dimensions,
    engines, unattributedRuns, versionCollisions,
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

// The run-token pool clause: ENUMERATE the three pools, each printed only when it holds runs and
// each labelled by the OBSERVABLE property that put a run there — round <= 1 (first-pass), round > 1
// (re-review), or no round recorded — never by a supposed CAUSE. A round-less run is NOT asserted to
// "predate the `round` field": `review` has current early-exit paths that stamp `outputTokens` with
// no `round`, and engines other than `review` never stamp it at all, so the analyzer cannot know why
// a run is round-less and claims nothing. The round-less pool prints on its own N, independent of the
// other two — so an all-round-less bucket still surfaces its pool with a label rather than as a bare
// figure. Named a POOL, never "output": `outputTokens` is budget.spent(), not output tokens.
function poolClause(w) {
  let s = ''
  if (w.avgRunTokenPoolFirstPass != null) s += ` · ~${w.avgRunTokenPoolFirstPass} tok-pool/run (first-pass)`
  if (w.avgRunTokenPoolReReview != null) s += ` · ~${w.avgRunTokenPoolReReview} tok-pool/run (re-review)`
  if (w.poolUnclassifiedN) s += ` · ~${w.avgRunTokenPoolUnclassified} tok-pool/run (round not recorded)`
  return s
}

// The REAL per-run cost clause — printed only for a workflow with at least one enriched run.
// cacheRead LEADS because it is the spend (~99% of it), where the pool clause above is under 1%.
// Silent for an un-enriched workflow: absence of `cost` is "not measured", never "cost zero" — the
// same stance the pool split takes for a missing `round`. The other three token classes and the
// total ride alongside so the one line carries the whole real cost.
function costClause(w) {
  if (!w.costRuns) return ''
  return ` · ~${w.avgCacheReadPerRun} cache-read tok/run (REAL cost; ~${w.avgCostTotalPerRun} tok/run total`
    + ` — cacheWrite ${w.avgCacheWritePerRun}, input ${w.avgCostInputPerRun}, output ${w.avgCostOutputPerRun}`
    + `; ${w.costRuns} enriched run(s))`
}

// The surface gate's saving (realm @nick/craft #102) — reported PER WORKFLOW, like the pool/cost
// clauses above, and only for a workflow that carries at least one gate-present run: a slice where
// every run predates the field (or belongs to an engine that never writes it, e.g.
// `adversarial-review`) has nothing to report, and printing "0 saved" there would be exactly the
// zero-fill `tallySurfaceGate` exists to refuse. When NOT ONE workflow in the whole aggregate carries
// the field, the section still prints — silence here would read as "nothing to report" rather than
// "not recorded yet", the same NOT-MEASURED-IS-NOT-ZERO stance the thinning clause takes.
//
// The SHARE (saved / (saved + gateable lenses that actually ran)) IS now computed, per workflow,
// from `sgShareSavedPasses`/`sgDispatchedPasses` — both scoped in `tallySurfaceGate` to runs that
// carry `surfaceGate.dispatched` (realm @nick/craft #102 follow-up: `dispatched` is read off
// review.js's module-level dispatch-point Set, the same reliable source `dropped` already subtracts
// against, so it survives the `gateFailed` early-exit that used to make "ran" unreliable from
// `dimensions` alone). A run recorded before `dispatched` existed is excluded from BOTH the
// numerator and the denominator — never zero-filled — and counted apart in `sgMissingDispatchedRuns`,
// surfaced as its own note so the gap stays visible instead of silently narrowing what the share
// claims to cover.
function renderSurfaceGateSection(a) {
  const L = ['## SURFACE GATE — whole-repo lens passes not bought']
  const withGate = a.workflows.filter(w => w.sgGateRuns > 0)
  if (!withGate.length) { L.push('- surface gate not recorded in this store'); return L }
  for (const w of withGate) {
    const preGateNote = w.sgPreGate ? ` (${w.sgPreGate} run(s) with no gate record, excluded here)` : ''
    const gateFailedNote = w.sgGateFailedRuns
      ? ` (${w.sgGateFailedRuns} run(s) whose mechanical gate failed before any lens ran, excluded)`
      : ''
    const byLens = Object.entries(w.sgSavedByLens).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
      .map(([lens, n]) => `${lens} ${n}`).join(', ')
    L.push(`- ${w.name}: ${w.sgGateRuns} run(s) carry the gate${preGateNote} · ${w.sgSavedRuns} run(s) saved ≥1 pass`
      + ` · ${w.sgSavedPasses} whole-repo pass(es) saved total${byLens ? ` (${byLens})` : ''}${gateFailedNote}`)
    const missingNote = w.sgMissingDispatchedRuns
      ? `${w.sgMissingDispatchedRuns} run(s) carry the gate but predate the dispatched count`
      : ''
    const shareDenominator = w.sgShareSavedPasses + w.sgDispatchedPasses
    if (shareDenominator > 0) {
      const share = round2(w.sgShareSavedPasses / shareDenominator * 100)
      L.push(`  Share (saved / (saved + dispatched)): ${share}% (${w.sgShareSavedPasses} saved, ${w.sgDispatchedPasses} dispatched)`
        + (missingNote ? ` — ${missingNote}, excluded from this share` : ''))
    } else if (missingNote) {
      // Denominator 0 is printed as no share at all, never as a fabricated 0/0 — the missing-dispatched
      // note still runs so a reader knows WHY, rather than reading silence as "nothing to report".
      L.push(`  Share: not reported — ${missingNote}`)
    }
  }
  return L
}

export function renderReport(a) {
  const L = [`# craft run analysis — ${a.totalRuns} run(s), ${a.incompleteRuns} with partial coverage`, '']
  // The engine boundary is stated BEFORE any number, not as a footnote after them: a reader who
  // has already read "findings/run 3.4" as a before/after has been misled, and a caveat underneath
  // does not take that back. Silence here is the whole defect — a mixed aggregate looks exactly
  // like a single-engine one.
  L.push(...renderEngineSection(a), '')
  // The version collision, stated before the numbers like the engine boundary above. The boundary
  // says the aggregate spans N engines but not that two of them wear the SAME version string — which
  // is the one thing a reader reaching for `--version` needs to know, because that filter cannot tell
  // them apart. (realm @nick/craft, #95)
  const collisions = Array.isArray(a.versionCollisions) ? a.versionCollisions : []
  if (collisions.length) {
    L.push('## ⚠️ VERSION COLLISION — one craftVersion, more than one engine revision')
    for (const c of collisions) {
      L.push(`- craftVersion ${c.version} spans ${c.revisions.length} engine revisions (${c.revisions.join(', ')})`
        + ' — the same version string is more than one engine; slice by `--engine`, not `--version`.')
    }
    L.push('')
  }
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
      // Named as a POOL, never "output", and split three ways by run type — see `poolClause` above.
      + poolClause(w)
      // The REAL cost (cache_read/write) beside the pool — enriched runs only; see `costClause`.
      + costClause(w))
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
  L.push('', ...renderSurfaceGateSection(a))
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
      // And say it outright when THIS slice actually blends revisions: a filter that returned records
      // from more than one engineRevision is a blend of different engines under one version string,
      // and the sound slice is `--engine`. (realm @nick/craft, #95)
      const slicedRevs = [...new Set(usable.map(revToken))].sort(revOrder)
      if (slicedRevs.length > 1) {
        versionNote += `\n_⚠️ This --version slice blends ${slicedRevs.length} engine revisions (${slicedRevs.join(', ')}) — it is more than one engine. Prefer \`--engine\` to compare like with like._`
      }
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
