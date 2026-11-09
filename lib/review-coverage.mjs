// The telemetry section every engine's report leads with when a record write or read could not be confirmed:
// the review driver (lib/cli-review-steps.mjs, lib/cli-review-record.mjs), rust-audit and triage-findings. Pure, so it
// lives in a real module, bundled into the engines and tested on its own.

// A run record is written by an agent shelling out to lib/craft-log-run.mjs, so the write can fail
// while the review itself is perfectly healthy: a craftRoot that has moved, a dead logger agent, a
// damaged store. Losing it used to be pure silence, and silence in the store is read as "this review
// was never run" — the permissive default wearing the face of a fact.
// The recorded decision is that this NEVER fails the run (a three-hour review killed by a bookkeeping
// write teaches everyone to ignore the marker); it is reported instead. Returns '' for a healthy run,
// so the marker cannot appear where nothing was lost — a marker that fires on healthy runs is one
// people stop reading, which is the same defect wearing the opposite sign.
// The body speaks about the WRITE, never about the run: it goes on every exit, including those whose
// verdict says nothing was reviewed (dead base resolution, unknown language pin, empty diff), where
// reassurance that "the review ran" would contradict the verdict itself. And it says "could not be
// confirmed", not "did not land": two of the three ways an entry gets here — an abandoned deadline
// (the logger agent is NOT cancelled and may still write) and a malformed reply — are compatible with
// a write that succeeded. Certainty we do not have is the same defect with the sign flipped.
// It LEADS the report rather than trailing it: a consumer that truncates (rust-audit clips an
// embedded review report to 4000 chars) would cut a tail marker off, leaving the silence intact.
// Each line ends up at the head of a human-facing report, and its text is model-authored (a logger
// agent quotes back what the script printed). Flattened and bounded so a reply cannot forge report
// structure — a heading, a verdict line — above the verdict the engine actually computed.
/** @param {unknown} lost */
export function telemetryLostSection(lost) {
  const lines = /** @type {unknown[]} */ (Array.isArray(lost) ? lost : []).filter(l => String(l ?? '').trim())
  if (!lines.length) return ''
  // A record that LANDED while its run directory did not is a different fact from a record nobody
  // can find, and counting it under "could not be confirmed" is how a banner earns its way onto the
  // list of things readers skip. The two are counted separately and the heading follows whichever is
  // actually true — the section is still one section, because both mean the store is not the whole
  // story for this run.
  const landed = lines.filter(l => /^the run directory \(the record itself landed\)/.test(String(l)))
  const unconfirmed = lines.length - landed.length
  const head = unconfirmed
    ? `${unconfirmed} record write(s)/read(s) for this run could not be confirmed, so the run store may be missing or incomplete for it. Read the verdict below — not the store — for what this run actually did.`
    : `This run's record is in the store, but ${landed.length} run director${landed.length === 1 ? 'y' : 'ies'} could not be folded into it, so what those held is not there. Read the verdict below for what this run actually did.`
  return [
    unconfirmed ? `## ⚠️ Telemetry lost` : `## ⚠️ Telemetry incomplete`,
    head,
    ...lines.map(l => `- ${String(l).replace(/[\r\n]+/g, ' ').slice(0, 300)}`),
    ``,
    ``,
  ].join('\n')
}
