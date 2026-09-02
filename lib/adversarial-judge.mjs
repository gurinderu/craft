// The adversarial verdict: how a set of verifier votes decides a finding. Lifted out of
// workflows/adversarial-review.js so it can be EXECUTED — the workflow cannot be imported (top-level
// export + await + return), and this is the function a dead verifier corrupts.
//
// WHY IT LIVES HERE. On 2026-09-02 a panel member died and the finding it was judging was dropped
// from the run: with `[refute, confirm, confirm]` the finding confirms, and losing one confirming
// lens makes `refutes * 2 < votes.length` false, i.e. REFUTED — and refuted findings are fed forward
// as "adversarially disproven, do not re-report". The mirror is as bad: two dead lenses leave a lone
// vote that confirms unconditionally. Silence must not vote, in either direction.
//
// Mirrored into workflows/adversarial-review.js by a `craft-inline` region; takes SEV_RANK as an
// argument because the workflow owns the severity vocabulary.

export function judgeVotes(findings, sink, SEV_RANK) {

  const calibrate = (f, votes) => {
    const sevs = votes.filter(v => !v.refuted && v.severity !== 'not-an-issue')
      .map(v => v.severity).sort((a, b) => SEV_RANK[a] - SEV_RANK[b])
    return sevs.length ? sevs[Math.floor(sevs.length / 2)] : f.severity
  }
  const judged = findings.map((f, idx) => {
    const all = sink[idx]
    // A missing vote must not decide — but "missing" is not the same as "undecidable". Ask what the
    // absent votes COULD have changed, and only fall back when they could have changed the answer.
    // Both traps are real and both were measured on this engine:
    //   [refute, confirm, confirm] confirms; losing one confirming lens made `refutes * 2 < votes`
    //     false, so the SAME finding was filed as refuted — and refuted findings never reach the
    //     report, they are fed forward as "adversarially disproven, do not re-report".
    //   Demoting on ANY absence is the inverse trap: [confirm, confirm, missing] cannot change —
    //     even a refuting third vote leaves 1*2 < 3 — so demoting it to Suspected drops a critical
    //     finding out of `confirmed`, and the verdict is built from `confirmed` alone. A silent
    //     Approve, in place of the Block that two independent lenses had earned.
    const missing = all.filter(v => v.missing).length
    const votes = all.filter(v => !v.missing)
    const refutes = votes.filter(v => v.refuted).length
    // The two extreme assignments of the absent votes. They agree → the absence changes nothing and
    // the answer stands; they disagree → the absent vote is the deciding one, and nobody cast it.
    const survivesIfAbsentRefute = votes.length > 0 && (refutes + missing) * 2 < all.length
    const survivesIfAbsentConfirm = votes.length > 0 && refutes * 2 < all.length
    const refuteUndecided = survivesIfAbsentRefute !== survivesIfAbsentConfirm
    const survives = !refuteUndecided && survivesIfAbsentRefute
    // An off-site premise no verifier could pin to real code is UNSUPPORTED, not disproven. It costs
    // the finding its Confirmed tier, but it must NOT be filed as refuted: the refuted list is fed
    // back to the next round as "adversarially disproven — do not re-report", which would bury a
    // possibly-real finding for the rest of the run over a missing citation.
    // The SAME two-assignment question is asked here. Resolving the absence pessimistically on this
    // axis ("assume the missing vote did not support") looks conservative and is not: it drops the
    // finding out of `confirmed`, the verdict is built from `confirmed` alone, and the run prints a
    // bare Approve — a missing vote deciding a critical finding, in the permissive direction, which
    // is the whole defect. `premiseSupported` is a required verifier field and a 1-1 split on a
    // 3-lens panel is an ordinary outcome, not a corner case.
    const supported = votes.filter(v => v.premiseSupported).length
    const unsupportedIfAbsentUnsupported = supported * 2 <= all.length
    const unsupportedIfAbsentSupported = (supported + missing) * 2 <= all.length
    const premiseUndecided = survives && unsupportedIfAbsentUnsupported !== unsupportedIfAbsentSupported
    const premiseUnsupported = survives && !premiseUndecided && unsupportedIfAbsentUnsupported
    const undecided = refuteUndecided || premiseUndecided
    const confirmed = survives && !premiseUnsupported && !premiseUndecided
    // `undecidedByAbsence` is the honest label for "nobody decided this": it is what a caller must
    // surface in the VERDICT, because a finding parked in Suspected does not downgrade anything.
    return { ...f, confirmed, premiseUnsupported, undecidedByAbsence: missing > 0 && (undecided || votes.length === 0), votes, severity: confirmed ? calibrate(f, votes) : f.severity }
  })
  return {
    confirmed: judged.filter(v => v.confirmed),
    // `degraded` is excluded here for the same reason `premiseUnsupported` is: the refuted list is
    // fed forward as "do NOT re-report — adversarially disproven", and a panel that never finished
    // disproved nothing. It falls to Suspected, which is what the not-run note has always claimed.
    refuted: judged.filter(v => !v.confirmed && !v.premiseUnsupported && !v.undecidedByAbsence && v.votes.length > 0),
    suspected: judged.filter(v => v.undecidedByAbsence || v.votes.length === 0 || v.premiseUnsupported),
  }
}
