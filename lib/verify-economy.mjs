// ================= What verification may stop buying, and on what evidence =================
// `verifyTier` already refuses to spend a verifier on Low/Info, and the reason it gives is not about
// severity at all — it is about the VERDICT: no combination of judgements on those findings can move
// Approve/Warning/Block, so the agent buys nothing. That reasoning was never carried to the tier
// where the money actually is. `reviewVerdict` is a three-line rule: a confirmed Critical or High
// makes the verdict Block, and once it is Block, EVERY Medium is verdict-neutral — confirmed,
// suspected or refuted, the answer is Block either way. Medium is also the whole batched population:
// one measured run carried 215 findings of which 78 were Medium, and verification was 79% of the
// run's wall clock across 125 agents.
//
// THE ORDER IS THE WHOLE DIFFICULTY, and it is why this is a floor object rather than a predicate on
// the finding list. Before a Critical is CONFIRMED, a Medium can still decide between Warning and
// Approve, so a skip justified by an expected Block is a skip justified by a guess. The floor is
// therefore append-only and evidence-only: it is raised by a judged finding that has already come
// back confirmed at Critical/High, and `secured()` answers about the past, never about the future. A
// caller asks it at the moment it is about to dispatch; asked earlier it says no, and the check is
// simply bought.
//
// SEVERITY IS READ OFF THE JUDGED FINDING, not the candidate. `tierFromVotes` demotes a confirmed
// High to Medium when no verifier could put it on a production-reachable path, and `reviewVerdict`
// counts the demoted severity — so a demoted finding must not raise the floor, and reading the
// post-verdict object is what makes that automatic rather than remembered.
//
// PURITY IS THE CONTRACT, as in lib/review-waves.mjs: nothing here logs, dispatches, or reads
// workflow state. It lives outside the workflow because workflows/review.js cannot be imported, and
// is pasted back in verbatim through a `craft-inline` fenced region.

// The severities whose confirmation alone forces Block, per `reviewVerdict` in lib/run-record.mjs.
// Kept as data next to the rule it mirrors: if that rule ever gains a severity, the skip below is
// wrong in the direction of skipping too much, and this is the one line to change.
export const BLOCKING_SEVERITIES = ['Critical', 'High']

// Does this JUDGED finding, by itself, already fix the verdict at Block?
export function securesBlock(f) {
  return !!f && f.tier === 'confirmed' && BLOCKING_SEVERITIES.includes(f.severity)
}

// A monotonic record of "the verdict is already Block, on evidence". Shared across concurrently
// dispatched verification entries on purpose — the same reason the death breaker is shared: the
// individual panel and the batch groups are in flight together, so a per-entry view would never see
// the confirmation another entry brought back.
export function makeVerdictFloor() {
  let by = null
  return {
    // Feed every settled verdict through here, judged or not. Returns whether THIS one raised the
    // floor, which is what a caller logs.
    record(f) {
      if (by !== null || !securesBlock(f)) return false
      by = f
      return true
    },
    // Answers about what has ALREADY come back. Never predicts.
    secured() {
      return by !== null
    },
    // The finding that raised it, so a skip can name its own justification instead of asserting one.
    securedBy() {
      return by
    },
  }
}

// Can a verifier for this finding still move the verdict, given what is already confirmed?
// Medium and nothing else: Critical/High decide the verdict themselves and are never skipped, and
// Low/Info never reach here — `verifyTier` has already routed them to the skip tier for a reason
// that does not depend on the floor.
export function verdictNeutralNow(f, floor) {
  return !!f && f.severity === 'Medium' && !!floor && floor.secured()
}

// Why a Medium went unverified, in the finding's own `why`. It names the evidence — the confirmed
// finding that fixed the verdict — because "we did not check this" is only legitimate when the
// reader can see what made the check pointless.
export function floorSkipReason(floor) {
  const by = floor && floor.securedBy()
  const where = by ? `${by.severity} "${by.title || '?'}" at ${by.file || '?'}:${by.line || 0}` : 'a confirmed blocking finding'
  return `no verifier was spent on it — the verdict was already fixed at Block by the confirmed ${where}, and no judgement on a Medium can move Block either way, so nothing here has been checked against the code`
}
