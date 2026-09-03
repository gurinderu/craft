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

// A verdict object we cannot read is not a verdict. `onResult` spreads whatever the agent returned
// (`{...true}` and `{...{}}` both yield an object with none of the fields), and this engine already
// records a live agent returning WITHOUT a schema-`required` field — so `required` in the schema is
// not a guarantee. Unread fields would otherwise vote: a missing `refuted` counts as non-refuting, a
// missing `premiseSupported` as non-supporting, and an `undefined` severity survives into the median
// where `SEV_RANK[undefined]` makes the comparator NaN and the confirmed finding can come out with no
// severity at all — which `baseVerdict` reads as neither critical nor high, i.e. Approve.
export function usableVote(v, SEV_RANK) {
  return !!v && typeof v === 'object'
    && typeof v.refuted === 'boolean'
    && typeof v.premiseSupported === 'boolean'
    && (v.severity === 'not-an-issue' || SEV_RANK[v.severity] != null)
}

export function judgeVotes(findings, sink, SEV_RANK) {

  // Severity is the THIRD decision axis, and the one that produces the verdict: `baseVerdict` reads
  // Block from a confirmed critical/high, Warning from a medium, Approve otherwise. So the absent
  // vote must be asked the same question here as on the other two — and it was not, which is how a
  // dead lens turned Block into Approve while both other axes agreed and nothing was flagged.
  // The median is taken over the FULL panel: a panel of three whose members voted [high, low] and
  // lost one has median index 1 of TWO, i.e. the milder — absence pulling severity down.
  const ranks = Object.keys(SEV_RANK).sort((a, b) => SEV_RANK[a] - SEV_RANK[b])
  const MOST = ranks[0]
  const LEAST = ranks[ranks.length - 1]
  // Which side of the verdict this severity falls on. Comparing TIERS, not severities, keeps the
  // marker narrow: critical vs high both mean Block, and flagging that as undecided would fire on
  // runs where the absence changed nothing — a false INCOMPLETE is no safer here than a false clean.
  const tierOf = sev => (SEV_RANK[sev] <= SEV_RANK.high ? 'block' : sev === 'medium' ? 'warning' : 'approve')
  const calibrateWith = (f, votes, missing, pad) => {
    const sevs = votes.filter(v => !v.refuted && v.severity !== 'not-an-issue')
      .map(v => v.severity)
      .concat(Array.from({ length: missing }, () => pad))
      .sort((a, b) => SEV_RANK[a] - SEV_RANK[b])
    return sevs.length ? sevs[Math.floor(sevs.length / 2)] : f.severity
  }
  // The absent votes padded with what the FINDER claimed — a neutral stand-in, where their silence
  // was not. Only used once the two extremes agree that the verdict cannot swing either way.
  const calibrate = (f, votes, missing) => calibrateWith(f, votes, missing, f.severity)
  const judged = findings.map((f, idx) => {
    // Malformed votes become absences, so the two-assignment machinery below decides them rather than
    // letting an unreadable object count as a non-refuting, non-supporting, severity-less confirmation.
    const all = (sink[idx] || []).map(v => (v && !v.missing && usableVote(v, SEV_RANK)) ? v : { lens: v && v.lens, missing: true })
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
    const severityUndecided = survives && !premiseUnsupported && missing > 0
      && tierOf(calibrateWith(f, votes, missing, MOST)) !== tierOf(calibrateWith(f, votes, missing, LEAST))
    const undecided = refuteUndecided || premiseUndecided || severityUndecided
    const confirmed = survives && !premiseUnsupported && !premiseUndecided && !severityUndecided
    // `undecidedByAbsence` is the honest label for "nobody decided this": it is what a caller must
    // surface in the VERDICT, because a finding parked in Suspected does not downgrade anything.
    // What the run would have printed had the absent votes come back at their worst. The caller must
    // gate its blocking entry on THIS, not on the finder's own label: the finder's severity and lens
    // are what shaped the panel, not what the verdict would have been. A single verifier can calibrate
    // a `medium` finding up to `critical`, and a `high` complexity finding gets one verifier and no
    // panel — both are "nobody decided this, and deciding it would have blocked the run".
    const undecidedByAbsence = missing > 0 && (undecided || votes.length === 0)
    const reachable = votes.length ? calibrateWith(f, votes, missing, MOST) : MOST
    // Only meaningful on a finding nobody decided: on a decided one the answer is the answer.
    const couldHaveBlocked = undecidedByAbsence && tierOf(reachable) === 'block'
    return { ...f, confirmed, premiseUnsupported, couldHaveBlocked, undecidedByAbsence, votes, severity: confirmed ? calibrate(f, votes, missing) : f.severity }
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
