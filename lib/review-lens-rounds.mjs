// A profile's lens rounds (src/review.js, Lenses phase): loop until dry over the sliced diff, the extra lenses
// beside round 1, the resurrection sweep, and the dispatches that never returned.
import { priorFoundSummary } from './review-coverage.mjs'
import { sliceableLens, WHOLE_DIFF_LENSES } from './lens-scope.mjs'
import { summarizeFindings } from './run-record.mjs'
import { weightedWindow } from './review-waves.mjs'

/**
 * @typedef {import('./review-schemas.mjs').Finding} Finding
 * @typedef {import('./review-profiles.mjs').Profile} Profile
 * @typedef {import('./review-schemas.mjs').FindingsAnswer} FindingsAnswer
 * @typedef {import('./review-run.mjs').ReviewRun} ReviewRun
 * @typedef {import('./review-plan.mjs').Plan} Plan
 */
/**
 * @typedef {ReturnType<typeof import('./review-lens-dispatch.mjs').makeLensDispatch>} Dispatch
 * @typedef {ReturnType<typeof import('./review-lens-prompts.mjs').makeLensPrompts>} Prompts
 * @typedef {ReturnType<typeof import('./review-extra-lens-run.mjs').makeExtraLenses>} Extras
 * @typedef {Awaited<ReturnType<typeof import('./review-crate-scope.mjs').openCrateScope>>} CrateScope
 * @typedef {import('./crate-scope.mjs').CrateGroup} Slice
 */

/**
 * One profile's lens pool, and the coverage ledger of its dispatches.
 * @param {ReviewRun} reviewRun
 * @param {{ profile: Profile, plan: Plan, seedFindings: Finding[], scoutNotRun: string[], runLens: Dispatch['runLens'], dispatchKey: Dispatch['dispatchKey'], lensPrompt: Prompts['lensPrompt'], lensFailures: Map<string, string>, extraLensesFor: Extras['extraLensesFor'], pushUnseen: Extras['pushUnseen'], branch: string, head: string, baseRef: string, thisRound: number, cs: CrateScope }} lens
 */
export async function lensRoundsPhase(reviewRun, { profile, plan, seedFindings, scoutNotRun, runLens, dispatchKey, lensPrompt, lensFailures, extraLensesFor, pushUnseen, branch, head, baseRef, thisRound, cs }) {
  const { key, checkpoint, extraLensGaps } = reviewRun
  const { log: logLine, parallel: runParallel, phase: enterPhase } = reviewRun.sb
  // ---- Lenses (loop-until-dry) ----
  enterPhase('Lenses')
  /** @type {Set<string>} */
  const seen = new Set()
  /** @type {Finding[]} */
  const pool = []
  // A gate seed is round 0 of the lens-round yield (lib/lens-round-yield.mjs).
  for (const f of seedFindings) { const k = key(f); if (!seen.has(k)) { seen.add(k); pool.push({ ...f, foundInRound: 0 }) } }
  const profileNotRun = [...scoutNotRun]
  // ONE coverage ledger, counted over DISPATCHES. There used to be a second, `ranAtLeastOnce`, and
  // after the dispatch accounting landed it was written twice and read nowhere — dead state whose
  // comment still claimed a role, which is how a reader comes to believe there are two ledgers that
  // might disagree. A dispatch that was expected and never came back is a hole whatever its
  // siblings did, and that is the whole of it.
  /** @type {Set<string>} */
  const expectedDispatches = new Set()
  /** @type {Set<string>} */
  const returnedDispatches = new Set()
  /** @type {Array<{ round: number, agents: number, returned: number, newFindings: number }>} */
  const lensRounds = []
  // Computed ONCE for the whole profile, not per round: the changed-file set does not move between
  // rounds, and re-slicing per round would let a lens's slice key drift between round 1 and round 2
  // for no reason a reader could follow in the transcript.
  // ALL changed files go in, with the profile asked INSIDE. Filtering to the profile first would
  // drop the manifest and the lockfile before slicing, and a slice that cannot see the manifest
  // cannot tell that a shipped CRD lacks the field the code writes.
  // The slices are crateScope's (lib/review-crate-scope.mjs): by crate when it is on, the directory slicing otherwise.
  const diffSlices = cs.slices
  if (diffSlices.length) logLine(`[${profile.id}] diff sliced into ${diffSlices.length} scope(s) for the code-intrinsic lenses${cs.on ? ' (crate-scoped)' : ''}: ${diffSlices.map(g => `${g.key} (${g.files.length})`).join(' · ')}. Whole-diff lenses (${WHOLE_DIFF_LENSES.join(', ')}) still see everything.`)
  /** Each dispatch's slice by its key, for a resurrection that keeps a crate slice's confinement. @type {Map<string, { lens: string, slice: Slice | null }>} */
  const dispatchOf = new Map()
  /** @param {string} lens @param {Slice | null} slice @param {string} tag @param {string} priorSummary */
  const promptFor = (lens, slice, tag, priorSummary) => (lens === 'contract' && slice ? cs.contractPrompt(slice, priorSummary) : lensPrompt(lens, priorSummary, profile, plan, slice, cs.crateOf(slice, tag)))
  // `[null]` means "one dispatch, unsliced" — the shape the caller had before slicing existed, so
  // the unsliced path stays the same code rather than a branch that can drift from it.
  const lensSlicesFor = (/** @type {string} */ lens) => (diffSlices.length && sliceableLens(lens) ? diffSlices : [null])
  // One round of the lens loop; true when it surfaced nothing new (the loop is dry).
  /** @param {number} round */
  async function lensRound(round) {
    const priorSummary = priorFoundSummary(pool)
    // EXPECTED is built from the same expression that dispatches, so the two cannot drift. What a
    // lens fanned out into is now the unit of coverage: before slicing, a lens either ran or did
    // not, and a death forced INCOMPLETE. With six slices per lens, five could die while one
    // returned — and a name-keyed "did this lens run" answers yes, `droppedLenses` comes back
    // empty, and the run reports an ordinary verdict over five sixths of a diff that no lens of
    // that kind ever read. Slicing multiplies the chances of losing coverage by the slice count, so
    // the accounting has to be per slice or the whole partition is a way of hiding holes.
    const dispatches = plan.lenses.flatMap(lens => lensSlicesFor(lens).map(slice => ({ lens, slice, tag: cs.tag(lens, slice, round) }))).concat(cs.contracts(round))
    for (const d of dispatches) { expectedDispatches.add(dispatchKey(d.lens, d.slice)); dispatchOf.set(dispatchKey(d.lens, d.slice), d) }
    // crateScope's coordinator for this round, beside its lenses; null when off.
    const coord = cs.coordinate(round, dispatches)
    // WINDOWED, for the same measured reason verification is. Slicing turns a wave of a dozen lenses
    // into one of ~70, and an unwindowed wave that size makes agents queue — while the Lenses
    // deadline clocks from DISPATCH, so the wait is inside it and it fires on healthy agents that
    // did nothing but stand in line. Applying the mitigation this file already documents for this
    // exact shape, rather than discovering it again.
    const settled = await weightedWindow(
      dispatches.map(d => ({ weight: 1, run: () => runLens(d.lens, promptFor(d.lens, d.slice, d.tag, priorSummary), 'Lenses', ` r${round}${d.slice ? ` ${d.slice.key}` : ''}`, d.slice) })),
      cs.window,
      (run, i) => run().then(r => (r ? { ...r, __key: dispatchKey(/** @type {(typeof dispatches)[number]} */ (dispatches[i]).lens, /** @type {(typeof dispatches)[number]} */ (dispatches[i]).slice), __lens: /** @type {(typeof dispatches)[number]} */ (dispatches[i]).lens } : null)),
    )
    const landedResults = settled.filter(r => r != null)
    await cs.settle(round, coord, landedResults)
    // `__lens`, not the model's `lens` field. Coverage already avoided trusting it; the finding's
    // `source` and the ran-set did not, and a dispatch answering with a mangled name sent its
    // findings to `source: 'unknown'` while its dimension row read `ran: true` with zero findings —
    // the yield inversion `ranLenses` exists to prevent, arriving one field over.
    for (const r of landedResults) returnedDispatches.add(r.__key)
    const fresh = []
    for (const r of landedResults) {
      for (const f0 of (r.findings || [])) {
        const f = { ...f0, source: r.__lens, foundInRound: round }
        const k = key(f)
        if (!seen.has(k)) { seen.add(k); fresh.push(f) }
      }
    }
    pool.push(...fresh)
    // Per-round yield, persisted to the run record. Lenses are the other half of a review's cost
    // (182 min / 31 agents on a measured run) and every round re-runs EVERY lens over the whole
    // diff, but whether round 2 earns that is unknowable after the fact: the gate's seed findings
    // make the pool non-empty from round 1, so a transcript cannot be split by round. Record it
    // rather than guess — a later `maxRounds` cut should be argued from these numbers.
    // ONE LINK THE "a finding cannot be lost" CHAIN DID NOT HAVE, recorded here because this is where
    // a reader looks for it. `if (!fresh.length) dry = true` below ends the search, and the
    // ALREADY-FOUND cap (priorFoundSummary) makes a withheld entry MORE likely to be re-surfaced:
    // `seen` drops it as a duplicate, `fresh` comes back empty, the round reads as dry and the loop
    // stops. No finding is lost — the pool keeps every entry and priors are adjudicated on their own
    // track — but the SEARCH can end a round early, and `newFindings` here (the very number a later
    // `maxRounds` cut would be argued from) is biased downward by the same mechanism.
    // Deliberately NOT fixed: a re-surfaced duplicate is indistinguishable from a genuinely dry round
    // at this point, so "dry unless something new that is not a known duplicate" would mean splitting
    // the `seen` key set by provenance and paying an extra full round of lens cost — against a prompt
    // saving that is about 1.8% of what the lens agents read. So do not read a dry round as proof the
    // diff is exhausted, and do not argue a round cut from `newFindings` alone.
    // `agents` is what was DISPATCHED this round, which with slicing is lenses × slices and no
    // longer the lens count. Left as `plan.lenses.length` it undercounted, so `returned` could
    // exceed it and any death accounting downstream read inverted — and this is the field that
    // makes a lost slice visible in the record at all.
    lensRounds.push({ round, agents: dispatches.length, returned: landedResults.length, newFindings: fresh.length })
    logLine(`[${profile.id}] Lenses round ${round}: +${fresh.length} new (pool ${pool.length})`)
    return !fresh.length
  }
  // The consumer's own agents (realm @nick/craft, node #295) run once, beside round 1, in the first
  // profile only: they review the whole change, so a second profile would buy them twice.
  const extraFindings = extraLensesFor(profile, pool)
  let dry = false
  for (let round = 1; round <= plan.maxRounds && !dry; round++) dry = await lensRound(round)
  pushUnseen(await extraFindings, seen, pool)
  profileNotRun.push(...extraLensGaps(profile))

  // ---- Resurrection sweep ----
  // A lens agent occasionally returns null on a transient API death / connection drop. That
  // dispatch is then counted as a hole in the ledger, and a hole alone marks the whole review
  // INCOMPLETE — even when the surviving
  // lenses found plenty. Since the failure is transient, a targeted retry of ONLY the missing lenses
  // recovers most of them. Bounded to 2 extra attempts; re-uses the same runLens/lensPrompt path.
  // MISSING IS NOW A DISPATCH QUESTION. A lens that lost one slice of six is not recovered by the
  // fact that its other five returned, so the sweep must see it — and the retry it sends is
  // deliberately UNSLICED, which is why recovering it restores the lens's whole coverage below.
  const lensesWithHoles = () => plan.lenses.filter(l => [...expectedDispatches].some(k => (k === l || k.startsWith(`${l} :: `)) && !returnedDispatches.has(k)))
  // What a sweep retries: each missing lens unsliced, and under crateScope each missing crate slice on its
  // own — still confined, with no coordinator to ask. A lens whose holes include a slice outside every crate
  // is retried unsliced, as before, and counted as an unconfined retry.
  /** @param {string[]} missing @returns {Array<{ lens: string, slice: Slice | null }>} */
  function resurrectionAttempts(missing) {
    if (!cs.on) return missing.map(lens => ({ lens, slice: null }))
    return missing.flatMap(/** @returns {Array<{ lens: string, slice: Slice | null }>} */ lens => {
      const holes = [...expectedDispatches].filter(k => k.startsWith(`${lens} :: `) && !returnedDispatches.has(k)).map(k => dispatchOf.get(k)?.slice ?? null)
      const confined = /** @type {Slice[]} */ (holes.filter(sl => sl?.crate))
      return confined.length && confined.length === holes.length ? confined.map(slice => ({ lens, slice })) : [{ lens, slice: null }]
    })
  }
  // A confined retry closes its own slice's hole only.
  /** @param {FindingsAnswer & { __lens: string }} r @param {Slice} slice */
  function absorbConfined(r, slice) {
    returnedDispatches.add(dispatchKey(r.__lens, slice))
    cs.noteResurrected(true)
    for (const f0 of (r.findings || [])) { const f = { ...f0, source: r.__lens }; const k = key(f); if (!seen.has(k)) { seen.add(k); pool.push(f) } }
  }
  // A resurrected lens's answer: its holes closed, its new findings pooled.
  /** @param {FindingsAnswer & { __lens: string, __slice?: Slice | null }} r */
  function absorbResurrected(r) {
    const lens = r.__lens
    if (r.__slice) return absorbConfined(r, r.__slice)
    // Under crateScope an unsliced retry read the whole diff unconfined: the record counts it.
    if (cs.on && [...dispatchOf.entries()].some(([k, d]) => k.startsWith(`${lens} :: `) && d.slice?.crate)) cs.noteResurrected(false)
    // A resurrection dispatch carries NO slice, so it reviewed the whole diff — which is exactly
    // what closes every hole this lens had. Marking only the lens name would leave the per-slice
    // ledger still reporting holes that were just filled, and the run would claim INCOMPLETE over
    // coverage it actually has.
    for (const k of expectedDispatches) if (k === lens || k.startsWith(`${lens} :: `)) returnedDispatches.add(k)
    for (const f0 of (r.findings || [])) {
      const f = { ...f0, source: lens }
      const k = key(f)
      if (!seen.has(k)) { seen.add(k); pool.push(f) }
    }
  }
  async function resurrectionSweep() {
    let missing = lensesWithHoles()
    for (let sweep = 1; sweep <= 2 && missing.length; sweep++) {
      logLine(`[${profile.id}] Resurrection sweep ${sweep}: retrying ${missing.length} lens(es) that never returned (${missing.join(', ')})`)
      const priorSummary = priorFoundSummary(pool)
      // Carries the lens it DISPATCHED alongside the answer. Everywhere else this accounting refuses
      // to trust the model-returned `lens` field, and here it was still being trusted: a resurrection
      // that succeeded but answered with a missing or mangled `lens` closed no holes, so the sweep
      // kept seeing them, both attempts were spent, and the run reported INCOMPLETE over coverage it
      // actually had. A false hole that cannot be cleared is as much a lie as a hidden one.
      const attempts = resurrectionAttempts(missing)
      const settled = await runParallel(attempts.map(a => () =>
        runLens(a.lens, a.slice ? promptFor(a.lens, a.slice, '', priorSummary) : lensPrompt(a.lens, priorSummary, profile, plan), 'Lenses', ` resurrect${sweep}${a.slice ? ` ${a.slice.key}` : ''}`, a.slice)
          .then(r => (r ? { ...r, __lens: a.lens, __slice: a.slice } : null)),
      ))
      const resurrected = settled.filter(r => r != null)
      for (const r of resurrected) absorbResurrected(r)
      missing = lensesWithHoles()
    }
  }
  await resurrectionSweep()
  // crateScope's seam pass, before the ledger is read: its findings and dispositions are part of the pool.
  await cs.seam(pool, seen, profileNotRun, pushUnseen)

  // DERIVED by subtraction from what was dispatched, never from a list built beside it. A lens whose
  // every slice returned contributes nothing here; a lens that lost one slice of six is reported as
  // losing that slice, by name, because "safety ran" is true and useless when five sixths of the
  // diff got no safety review.
  // The dispatches that never returned, each with its reason, carried into notRun and the log.
  function reportDroppedLenses() {
    const neverReturned = [...expectedDispatches].filter(k => !returnedDispatches.has(k))
    if (neverReturned.length) {
      // Falls back to the BARE lens name, because the resurrection sweep dispatches unsliced and can
      // only key its failure that way. Without the fallback every sliced hole read "died without an
      // error" even when the retry died with a captured message — losing the diagnosis for exactly
      // the sliced case, which is what keying by dispatch was introduced to fix.
      const reasonFor = (/** @type {string} */ k) => lensFailures.get(k) || lensFailures.get(k.split(' :: ')[0] ?? k) || 'returned no result (skipped or died without an error)'
      const reasons = neverReturned.map(k => `${k}: ${reasonFor(k)}`).join(' · ')
      profileNotRun.push(`${profile.id} lenses that never returned — ${reasons}`)
      logLine(`⚠️ [${profile.id}] ${neverReturned.length} lens dispatch(es) never returned (${reasons}). Review marked INCOMPLETE.`)
    }
    return neverReturned
  }
  const droppedLenses = reportDroppedLenses()
  // `ranLenses` rides along to the record: the dimension rows are built from plan.lenses, so a lens
  // that never returned still gets a row reading 0 findings — indistinguishable from a lens that ran
  // and found nothing. That is the difference between "redundant, consider dropping it" and "broken,
  // fix it", and the yield analysis inverts on it.
  // FULLY ran, not "ran at all". A lens that returned one slice of six covered a sixth of the diff,
  // and a dimension row built from the looser test presents its partial findings as whole-diff
  // coverage — "safety ran" is true and useless, which is exactly the phrasing the accounting above
  // rejects. The verdict is already saved by `droppedLenses`; this is the reader's fidelity.
  const ranLenses = plan.lenses.filter(l => [...expectedDispatches].every(k => (k !== l && !k.startsWith(`${l} :: `)) || returnedDispatches.has(k)))
  ranLenses.push(...cs.ran(expectedDispatches, returnedDispatches))
  // The lens phase is the expensive half of a review and the half most often lost: on the run that
  // prompted this, verification died to a usage limit and took every lens's yield with it.
  // `branch`/`head` on every checkpoint, not only the first. `--rejoin` can be armed ONLY after a
  // checkpoint failed, so it is never armed on the `-plan` payload — and `-plan` was the only one
  // carrying identity. The rejoin search therefore saw `{project, '', ''}` on exactly the paths where
  // it fires, and matched on the repository alone: any concurrent review of the same repo qualified.
  await checkpoint(`${profile.id}-lenses`, {
    language: profile.id, branch, head, baseRef, round: thisRound, ranLenses, droppedLenses, lensRounds,
    candidates: summarizeFindings(pool),
    candidatesBySource: pool.reduce((m, f) => ({ ...m, [f.source || 'unknown']: (m[f.source || 'unknown'] || 0) + 1 }), /** @type {Record<string, number>} */ ({})),
    notRun: profileNotRun,
  }, 'Lenses')
  return { pool, seen, profileNotRun, ranLenses, lensRounds }
}
