// The review's verification of a pool of findings (src/review.js, Verify phase): routed by tier, dispatched
// through one bounded window, individuals first, and settled into confirmed, suspected, unverified and refuted.
import { isToolSource } from './prior-decision-match.mjs'
import { depthVerifyTier, lightUnverifiedWhy } from './review-depth.mjs'
import { makeDeathBreaker } from './agent-retry.mjs'
import { VERIFY_WINDOW_AGENTS, verifyWeight, weightedWindow } from './review-waves.mjs'
import { makeVerdictFloor, verdictNeutralNow, floorSkipReason } from './verify-economy.mjs'
import { VERDICT_SCHEMA } from './review-schemas.mjs'
import { verifyPrompt, BATCH_SIZE, verifyTier, NOT_VERIFIED, votesAgree, tierFromVotes, batchVerifyPrompt } from './review-verify.mjs'

/**
 * @typedef {import('./review-schemas.mjs').Finding} Finding
 * @typedef {import('./review-profiles.mjs').Profile} Profile
 * @typedef {import('./review-schemas.mjs').BatchVerdictAnswer} BatchVerdictAnswer
 * @typedef {import('./review-run.mjs').ReviewRun} ReviewRun
 * @typedef {import('./review-plan.mjs').Plan} Plan
 */
/**
 * @template T
 * @typedef {import('./review-schemas.mjs').Schema<T>} Schema
 */
// Verify a pool of findings → {confirmed, suspected, dropped, refuted}. Rigor scales with the profile's plan.
// Staged verification: cull votes run on a cheap model (sonnet); a High/Critical additionally gets exactly
// ONE authoritative opus vote, so the cheap model can neither confirm nor drop a high-stakes finding alone.
export const CULL_MODEL = 'sonnet'

/**
 * The verification pass of one run.
 * @param {ReviewRun} reviewRun
 */
export function makeVerifyPool(reviewRun) {
const { reviewDepth, lightPass, ragent } = reviewRun
const { log: logLine, parallel: runParallel } = reviewRun.sb

// THE DEATH CLASS of a batch answer, or null when the verifier really did judge something. The
// three classes are kept APART rather than collapsed into one boolean: they are three distinct ways
// the answer can fail to arrive, and a single message for all of them makes a test that scripts one
// of them pass while the other two are unreached — the "neighbouring door" failure the death table
// below exists to prevent. Each class names itself in the finding's `why`, so a row of that table
// proves which branch it reached.
/** @param {unknown} res  the batch verifier's answer, which may be off-schema (see VOTE_AXES) */
function batchDeath(res) {
  if (!res) return 'returned nothing at all — a dead agent, an exhausted retry, or an expired deadline'
  const verdicts = /** @type {{ verdicts?: unknown }} */ (res).verdicts
  if (!Array.isArray(verdicts)) return 'answered OFF-SCHEMA — its answer carried no verdict list at all'
  if (!/** @type {unknown[]} */ (verdicts).length) return 'answered with an EMPTY verdict list — it judged nothing'
  return null
}


/** @type {Schema<BatchVerdictAnswer>} */
const BATCH_VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      description: 'one entry per finding in the batch, keyed by its index — every index must appear',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'refuted', 'citedLineMatches', 'reachable', 'premiseSupported', 'reason'],
        properties: {
          index: { type: 'integer' },
          refuted: { type: 'boolean' },
          citedLineMatches: { type: 'boolean' },
          reachable: { type: 'boolean' },
          premiseSupported: { type: 'boolean' },
          reason: { type: 'string' },
        },
      },
    },
  },
}
/** @param {Finding[]} items @param {Plan} plan @param {Profile} profile @param {string} gateProvenance */
async function verifyPool(items, plan, profile, gateProvenance) {
  // One breaker per verification pass, handed only to the dispatches this function windows. Its
  // lifetime is the pass: a profile's pass never inherits a window filled by another profile's,
  // whose API reachability it did not observe and whose deaths it cannot re-spend.
  const breaker = makeDeathBreaker()
  /** @type {{ individual: Finding[], batch: Finding[], skip: Finding[] }} */
  const route = { individual: [], batch: [], skip: [] }
  for (const f of items) route[/** @type {keyof typeof route} */ (depthVerifyTier(verifyTier(f), f['severity'], reviewDepth))].push(f)

  // What is ALREADY confirmed at a blocking severity, raised as the individual panel settles. A
  // batch thunk asks it at the moment it is about to dispatch, so the skip below can only ever rest
  // on evidence that has already come back — never on an expectation that a Critical will confirm.
  const floor = makeVerdictFloor()

  // Skipped tier: its OWN tier, `unverified` — not Suspected. Suspected means "a verifier looked and
  // the claim did not stand up confidently"; these were never looked at. Folding them into Suspected
  // made the two indistinguishable in the report AND put them in the refuteRate denominator, so a run
  // whose findings were mostly Low/Info reported a refutation rate diluted by items nothing refuted.
  /** @type {Finding[]} */
  const routedUnverified = route.skip.map(f => ({
    ...f,
    tier: 'unverified',
    why: lightPass ? `${f['why']} (NOT VERIFIED: ${lightUnverifiedWhy(f['severity'])})` : `${f['why']} (NOT VERIFIED: no verifier was spent on it — ${f['severity']} cannot change the verdict either way, so nothing here has been checked against the code)`,
  }))

  // Batched tier: group by file so one agent reads one file's context once.
  /** @type {Map<string, Finding[]>} */
  const byFile = new Map()
  for (const f of route.batch) {
    const k = f['file'] || '?'
    const at = byFile.get(k)
    if (at) at.push(f)
    else byFile.set(k, [f])
  }
  /** @type {Finding[][]} */
  const groups = []
  for (const [, fs] of byFile) for (let i = 0; i < fs.length; i += BATCH_SIZE) groups.push(fs.slice(i, i + BATCH_SIZE))

  // `notRun` is computed AFTER the window settles, from the findings that carry the unverified tier
  // — not pushed from inside one death branch. That placement is the fix: a list filled by whichever
  // branch remembered to push is exactly how the dominant death (a `null` answer) stayed out of the
  // verdict while the `.catch` branch was covered. Deriving it from the tier makes it impossible for
  // a new death path to reach the report as an inspection.
  // A whole group nothing judged, whatever killed it. The reason is a CLASS of death, not the
  // verbatim error text: the run record's `notRun` is ranked by exact string to surface repeated
  // fragility, and an error message (or a run-specific path) makes every entry unique and sinks the
  // real repeats — the same reason `uncoveredFiles` is ranked separately.
  const deadGroup = (/** @type {Finding[]} */ group, /** @type {string} */ why) => {
    const what = `the batch verifier for ${/** @type {Finding} */ (group[0])['file'] || '?'} ${why}`
    logLine(`⚠️ [${profile.id}] ${what} — its ${group.length} finding(s) were NOT checked against the code; reported as unverified and excluded from the verification counters`)
    return group.map((/** @type {Finding} */ f) => NOT_VERIFIED(f, `${what}, so nothing checked this finding against the code`))
  }

  // Batched and individual verification look at DISJOINT findings — routing put each one in exactly
  // one bucket — so awaiting the batch wave before starting the individual one bought nothing but
  // latency. Measured on one run: batches ran +81..89min and individuals +89..102min, strictly
  // nose-to-tail. They are built as two thunk lists sharing ONE ordered work list, so the slowest
  // batch no longer holds up the first verifier — but that list is dispatched through a BOUNDED
  // SLIDING WINDOW rather than all at once, because the per-agent deadline is measured from DISPATCH
  // and an unbounded fan-out makes it fire on queue wait instead of on hanging. A window, not waves:
  // waves gave the same cap but re-introduced a barrier per wave (see VERIFY_WINDOW_AGENTS).
  // A group whose verifier was never bought because the verdict was already fixed at Block. It takes
  // the same route as a death AS FAR AS THE TIERS GO — the unverified tier, out of the refutation
  // denominator — and for the same reason: nothing here was checked against the code. What it does
  // NOT do is disappear, and what it does NOT do either is enter `notRun`: that list means "this ran
  // badly; re-run it" and drives the INCOMPLETE marker, while this is a deliberate saving a re-run
  // would simply make again. It travels in `savedByFloor` instead (see the return of verifyPool),
  // and converts into `notRun` only if the Block it was justified by fails to arrive.
  // `verifySkipped` is the flag that keeps the two apart, since they need a re-run for opposite
  // reasons.
  const floorSkippedGroup = (/** @type {Finding[]} */ group) => {
    logLine(`💰 [${profile.id}] the batch verifier for ${/** @type {Finding} */ (group[0])['file'] || '?'} was NOT dispatched — ${floorSkipReason(floor)}; its ${group.length} finding(s) are reported as unverified and excluded from the verification counters`)
    return group.map((/** @type {Finding} */ f) => ({ ...NOT_VERIFIED(f, floorSkipReason(floor)), verifySkipped: true }))
  }

  const batchThunks = groups.map(group => () =>
    // Asked HERE, inside the thunk, not when the thunk list is built: the window dispatches lazily
    // and the individual panel goes first, so by the time a batch's turn comes the floor may have
    // been raised by a Critical that has actually come back confirmed. Asked at build time it would
    // always answer no, and the whole population would be bought.
    (verdictNeutralNow(group[0], floor)
      ? Promise.resolve(floorSkippedGroup(group))
      : ragent(batchVerifyPrompt(group, profile), { label: `verify-batch:${/** @type {Finding} */ (group[0])['file'] || '?'}(${group.length})`, phase: 'Verify', breaker, schema: BATCH_VERDICT_SCHEMA, model: CULL_MODEL })
      .then(res => {
        // THE DISCRIMINATOR. `ragent` answers `null` for a dead agent (API error, skip, or the
        // per-agent deadline) after its one re-dispatch, and that is the DOMINANT death — not the
        // throw the `.catch` below handles. An answer carrying no verdicts at all is the same
        // outcome by a different route: nothing was judged. Either way the group is unverified.
        const death = batchDeath(res)
        if (death) return deadGroup(group, death)
        return group.map((/** @type {Finding} */ f, /** @type {number} */ i) => {
          // `death` is null only for an answer carrying a non-empty verdict list, so `res` is set here.
          const v = (res?.verdicts ?? []).find(x => x && x['index'] === i)
          // A missing index in a NON-EMPTY verdict list is a verifier that ran and lost one finding —
          // an inspection happened, so this keeps `suspected`. This is the one case that must NOT be
          // folded into the unverified tier, and the only thing that separates it from a death.
          return v ? tierFromVotes(f, [v]) : { ...f, tier: 'suspected', why: `${f['why']} (batch verifier returned no verdict for this finding)` }
        })
      })
      // A batch verifier that THREW — both `ragent` attempts failed — judged nothing, so its group
      // belongs in `unverified`, exactly where the skipped Low/Info go, and by the same reasoning:
      // `suspected` is a claim that a verifier LOOKED and could not confirm, and the report now says
      // so in those words. Marking a dead verifier's findings suspected made the report assert an
      // inspection that never happened, and left up to BATCH_SIZE findings inside the `totalVerified`
      // denominator that is defined as what verification actually judged. One tier, one way in.
      // The verbatim error text is deliberately NOT carried into the finding or into `notRun`: see
      // the note on `deadGroup`. It is logged instead, where a unique string costs nothing.
      .catch((/** @type {unknown} */ err) => {
        logLine(`⚠️ [${profile.id}] batch verifier threw: ${String((err && /** @type {{ message?: unknown }} */ (err).message) || err).slice(0, 160)}`)
        return deadGroup(group, 'died before returning any verdict')
      })))

  if (route.skip.length || groups.length) {
    logLine(`[${profile.id}] Verify routing: ${route.individual.length} individual · ${route.batch.length} batched into ${groups.length} runAgent(s) · ${route.skip.length} NOT VERIFIED (Low/Info cannot move the verdict; reported as unverified, excluded from the verification counters)`)
  }

  const individualThunks = route.individual.map(f => () => {
    // A gate tool's seed (clippy-pedantic, statix, deadnix, semgrep, …) is deterministic and re-runnable, so a verifier refutes it only by re-running the tool; dep-context, a reasoning seed, is verified by argument like a lens finding (isToolSource, lib/prior-decision-match.mjs).
    const isTool = isToolSource(f['source'])
    const isHigh = f['severity'] === 'Critical' || f['severity'] === 'High'
    const n1 = isHigh ? Math.max(1, plan.verifyVotes) : 1
    // Cull votes on the cheap model.
    const cull = (/** @type {number} */ i) => () =>
      ragent(verifyPrompt(f, i, isTool, gateProvenance, profile), { label: `verify:${f['file'] || '?'}:${f['line'] || 0}#c${i + 1}`, phase: 'Verify', breaker, schema: VERDICT_SCHEMA, model: CULL_MODEL })
    if (!isHigh) return runParallel([cull(0)]).then(vs => tierFromVotes(f, vs))
    // A High/Critical always gets exactly one authoritative opus vote combined with the cull votes.
    const auth = () =>
      ragent(verifyPrompt(f, n1, isTool, gateProvenance, profile), { label: `verify:${f['file'] || '?'}:${f['line'] || 0}#auth`, phase: 'Verify', breaker, schema: VERDICT_SCHEMA, model: plan.lensModel })
    // Open with the DECIDING pair — one cheap cull plus the authoritative vote — and buy the remaining
    // cull votes only when those two disagree. tierFromVotes is a majority rule, so a unanimous pair
    // lands on exactly the tier a unanimous four would: the extra votes only ever change the outcome
    // when there is a split to break. Measured justification: on a security-sensitive Rust diff
    // verifyVotes is forced to 3, so every High cost 4 agents — 72 of one run's 137 — while the whole
    // verification pass refuted 3% of candidates. Nearly all of those votes were re-confirming an
    // already-unanimous verdict. When they DO split, the escalation restores the full n1+1 panel, so
    // no contested finding is decided on thinner evidence than before.
    return runParallel([cull(0), auth]).then(async vs => {
      const opening = vs.filter(Boolean)
      if (opening.length === 2 && votesAgree(opening[0], opening[1])) return tierFromVotes(f, opening)
      const rest = await runParallel(Array.from({ length: Math.max(0, n1 - 1) }, (/** @type {unknown} */ _unused, /** @type {number} */ i) => cull(i + 1)))
      return tierFromVotes(f, opening.concat(rest.filter(Boolean)))
    })
  })
  // A batch thunk resolves to an ARRAY of judged findings (one per finding in the group), an
  // individual thunk to a single one — flatten the batch side back out before merging. The window
  // settles out of order but writes each result at ITS OWN index, so the positional split below
  // stays exactly as valid as it was under one runParallel().
  //
  // INDIVIDUALS LEAD, and that ordering is the load-bearing part of the Medium economy above. The
  // window still has no barrier — the two tiers overlap freely — but it dispatches in list order, so
  // the Critical/High panel that can raise the verdict floor goes out first and a batch's turn comes
  // after some of it has come back. Batches first would ask the floor before anything could have
  // raised it, and the answer would always be "not yet".
  // Every settled individual verdict is offered to the floor. Wrapped here rather than inside the
  // thunk because the thunk has two return points, and a floor raised on one path but not the other
  // is the kind of half-wiring that leaves the saving silently unrealized.
  // `run` is `individualThunks[i]` for an in-range `i` (both lists map `route.individual`), hence the
  // cast; the result is typed as a window entry's so the batch thunks concatenate onto the same list.
  /** @type {(run: (() => Promise<Finding>) | undefined) => () => Promise<Finding | Finding[]>} */
  const withFloor = run => () => Promise.resolve(/** @type {() => Promise<Finding>} */ (run)()).then(r => {
    if (floor.record(r)) logLine(`💰 [${profile.id}] the verdict is now fixed at Block by a confirmed ${r.severity} (${r.file || '?'}:${r.line || 0}) — Medium batches not yet dispatched can no longer move it and will not be bought`)
    return r
  })
  const entries = route.individual.map((f, i) => ({ run: withFloor(individualThunks[i]), weight: verifyWeight(f, plan) }))
    .concat(batchThunks.map(run => ({ run, weight: 1 })))
  const totalWeight = entries.reduce((n, e) => n + e.weight, 0)
  if (totalWeight > VERIFY_WINDOW_AGENTS) {
    logLine(`[${profile.id}] Verify dispatched through a sliding window of ≤${VERIFY_WINDOW_AGENTS} agents (${totalWeight} worst-case agents queued) — a deeper queue makes the per-agent deadline fire on waiting rather than on hanging; the window refills as each verifier settles, so nothing waits on a batch's slowest member`)
  }
  // runParallel([run]) per entry, not one runParallel() over all of them: it is the sandbox primitive that
  // turns a throwing thunk into null, and a single-thunk barrier is no barrier at all.
  const settledVerdicts = await weightedWindow(entries, VERIFY_WINDOW_AGENTS, run => runParallel([run]).then(rs => rs[0]))
  // Death #6: `weightedWindow` writes `null` at an entry's own index when its promise rejected, and
  // `.filter(Boolean)` used to DELETE those findings outright — out of every tier, out of the
  // denominator AND out of `notRun`, so the report simply never mentioned them. A null is recovered
  // back into its own findings by index (the batch side knows its group, the individual side its
  // finding) and routed exactly like every other death.
  const judged = settledVerdicts.slice(0, route.individual.length)
    // The first `route.individual.length` entries are individual thunks, each settling to ONE finding.
    .map((r, i) => (/** @type {Finding | null | undefined} */ (r) || NOT_VERIFIED(/** @type {Finding} */ (route.individual[i]), 'the verifier panel for this finding was lost before it settled — nothing was checked against the code')))
  const batched = settledVerdicts.slice(route.individual.length)
    // ...and the rest are batch thunks, each settling to its group's judged findings.
    .flatMap((r, i) => (r ? /** @type {Finding[]} */ (r) : deadGroup(/** @type {Finding[]} */ (groups[i]), 'was lost before it settled (its dispatch never produced a result)')))
  /** @type {Finding[]} */
  const settled = judged.concat(batched)
  // A dead batch's findings arrive through the same list as judged ones and must leave it again:
  // `vp` is the JUDGED population and every count derived from it (candidates, refuteRate) means
  // "what verification actually examined".
  const vp = settled.filter(f => f.tier !== 'unverified')
  const deaths = settled.filter(f => f.tier === 'unverified')
  const refuted = vp.filter(f => f.tier === 'refuted')
  return {
    confirmed: vp.filter(f => f.tier === 'confirmed'),
    suspected: vp.filter(f => f.tier === 'suspected'),
    // Kept OUT of `vp` on purpose, from both of its sources: the Low/Info nothing was spent on, and
    // the groups whose batch verifier died.
    unverified: routedUnverified.concat(deaths),
    // DERIVED from the tier, not pushed by whichever branch remembered to. Grouped by file and
    // ranked-friendly: one stable string per (profile, file), no error text, no run-specific path.
    // THE ONE THINNING THAT LEAVES NO TRACE. A refuted finding is deleted from the run — out of
    // every tier and out of the report — so when its panel was thinned, the partial evidence it was
    // deleted on is visible nowhere: no finding to carry the clause, no mark, and a verdict that
    // reads clean. `notRun` is the existing mechanism for "this ran badly; re-run it", and it drives
    // the INCOMPLETE marker. DERIVED from the tier plus the flag tierFromVotes sets, like the
    // deaths above, and grouped by (profile, file) so the exact-string ranking in
    // lib/analyze-runs.mjs sees a repeat rather than a run-unique row.
    notRun: [...new Set([
      // THREE failures, kept apart by the same discipline that keeps error text out of the strings.
      // This list is ranked by exact string across runs, so collapsing any two makes one repeat
      // masquerade as another and sends the repair to the wrong place. A death is fragility a re-run
      // can fix; an off-schema panel ANSWERED and must not be called a death; a thinned refutation
      // deleted a finding on partial evidence. The deliberate floor skip is NOT here — see
      // `savedByFloor` below for why it cannot be.
      // Split on the flags tierFromVotes and floorSkippedGroup set, not on the wording of any `why`.
      ...deaths.filter(f => !f.verifySkipped && !((f.votesDiscarded ?? 0) > 0)).map(f => `${profile.id} verification of ${f.file || '?'} — the verifier(s) died before returning a verdict, so those finding(s) were never checked against the code`),
      ...deaths.filter(f => !f.verifySkipped && (f.votesDiscarded ?? 0) > 0).map(f => `${profile.id} verification of ${f.file || '?'} — every returned vote answered OFF-SCHEMA and was discarded before the arithmetic, so those finding(s) were never checked against the code`),
      ...refuted.filter(f => (f.votesDiscarded || 0) > 0).map(f => `${profile.id} verification of ${f.file || '?'} — a finding was REFUTED and deleted from the run by a THINNED PANEL (at least one returned vote answered off-schema and was discarded), so the deletion rests on partial evidence`),
    ])],
    // OUT of `notRun` on purpose, and this is the same call that was already made once for
    // `uncoveredFiles`. `notRun` means "this ran badly; re-run it": it drives the INCOMPLETE marker
    // on the verdict line, and lib/analyze-runs.mjs ranks it by exact string to surface repeated
    // FRAGILITY. A floor skip is the opposite of fragility — it is a deliberate, reproducible
    // saving that a re-run will simply make again. Left inside, it would do two kinds of damage,
    // both of them silent: every Block run carrying a batched Medium (the ordinary case) would
    // render as "⚠️ INCOMPLETE — coverage was partial … findings may be undercounted", which is a
    // false statement about coverage and, through rust-audit's leading-⚠️ rule, can pull a whole
    // audit down to Warning; and this string would become the most frequent row in the fragility
    // ranking, sinking the genuine repeats the ranking exists to surface. The findings themselves
    // are not hidden by this: they stay in the `unverified` tier, out of the refutation
    // denominator, and each carries its own `why` into the report's Unverified section.
    // Read across runs by lib/analyze-runs.mjs, which ranks it separately from the failures.
    savedByFloor: [...new Set(deaths.filter(f => f.verifySkipped).map(f => `${profile.id} verification of ${f.file || '?'} — deliberately not dispatched: the verdict was already fixed at Block, and no judgement on a Medium can move it, so those finding(s) were never checked against the code`))],
    dropped: refuted.length,
    refuted,
  }
}
return { verifyPool }
}
