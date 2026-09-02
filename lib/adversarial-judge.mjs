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
    // A panel that lost a member decides NOTHING — neither for the finding nor against it. Measured
    // on the shipped formula: `[refute, confirm, confirm]` confirms, and dropping one confirming
    // lens turns the SAME finding into `refutes * 2 < votes.length` = false, i.e. refuted — and
    // refuted findings never reach the report, they are fed forward as "adversarially disproven, do
    // not re-report". The mirror is as bad: two dead lenses leave a lone vote that confirms
    // unconditionally, so one flaky lens can manufacture a Block. Silence must not vote either way.
    const degraded = all.some(v => v.missing)
    const votes = all.filter(v => !v.missing)
    const refutes = votes.filter(v => v.refuted).length
    const survives = !degraded && votes.length > 0 && refutes * 2 < votes.length
    // An off-site premise no verifier could pin to real code is UNSUPPORTED, not disproven. It costs
    // the finding its Confirmed tier, but it must NOT be filed as refuted: the refuted list is fed
    // back to the next round as "adversarially disproven — do not re-report", which would bury a
    // possibly-real finding for the rest of the run over a missing citation.
    const premiseUnsupported = survives && votes.filter(v => v.premiseSupported).length * 2 <= votes.length
    const confirmed = survives && !premiseUnsupported
    return { ...f, confirmed, premiseUnsupported, degraded, votes, severity: confirmed ? calibrate(f, votes) : f.severity }
  })
  return {
    confirmed: judged.filter(v => v.confirmed),
    // `degraded` is excluded here for the same reason `premiseUnsupported` is: the refuted list is
    // fed forward as "do NOT re-report — adversarially disproven", and a panel that never finished
    // disproved nothing. It falls to Suspected, which is what the not-run note has always claimed.
    refuted: judged.filter(v => !v.confirmed && !v.premiseUnsupported && !v.degraded && v.votes.length > 0),
    suspected: judged.filter(v => v.degraded || v.votes.length === 0 || v.premiseUnsupported),
  }
}
