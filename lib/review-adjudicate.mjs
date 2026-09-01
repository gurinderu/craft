// ================= Adjudicate-track pure helpers =================
// The re-review adjudicate track decides, for every prior-round finding, whether the fix landed.
// These helpers are the pure core of that decision: the text hygiene applied to model-authored
// attack/note text, the marker-stripping that keeps `why` from accreting round over round, the
// red-team verdict handling, and the per-finding dispatch to a track.
//
// They live here, outside the workflow, for the same reason lib/review-coverage.mjs does:
// workflows/review.js cannot be imported (top-level `export` + `await` + `return` parse only
// inside the sandbox wrapper), so anything declared there can be tested only by eval'ing a prefix
// of the file — that is, by testing a COPY of the text rather than the code that runs. Here they
// are a real module: imported by real tests, linted, and pasted back into the workflow verbatim
// through a `craft-inline` fenced region (lib/inline-regions.mjs).
//
// PURITY IS THE CONTRACT. Nothing here may read workflow state, log, or call an agent — the
// caller does the logging and counting from the flags these functions return.

// Cap for any model-authored string that is persisted into the ledger, re-interpolated into a
// next-round prompt, or rendered in the report. Shared by sanitizeAttack and (in the workflow)
// flattenField, so one runaway agent response cannot balloon either path.
export const ATTACK_MAX = 500

// Model "attack"/"note" text is persisted into the ledger `why`, re-interpolated into next-round
// prompts, and rendered in the report — cap it and strip newline/markdown structure so runaway or
// injected output cannot restyle the report or compound across re-review rounds.
export function sanitizeAttack(text) {
  // Also break the baseWhy marker DELIMITER: collapse the ` — ` that precedes a `fix incomplete` /
  // `REGRESSED after fix` / `UNVERIFIED` marker word to a plain space. The words survive (no content
  // loss) but the exact ` — <marker>: ` shape baseWhy parses is gone — so an attack/note that echoes
  // a marker can no longer re-introduce a parseable marker that would accrete a stale fragment each
  // re-review round.
  const flat = String(text ?? '').replace(/[\r\n]+/g, ' ').replace(/[#`*_[\]<>|]/g, '')
    .replace(/ — (?=fix incomplete|REGRESSED after fix|UNVERIFIED)/gi, ' ').trim()
  return flat.length > ATTACK_MAX ? `${flat.slice(0, ATTACK_MAX)}…` : flat
}

// A still-open/regressed prior re-enters the next round's ledger with a suffix appended to `why`.
// Strip any PRIOR suffix first so stale attacks do not accrete and bias future adjudications (the
// adjudicator and red-team derive the invariant from `why`). Honest invariant: `why` carries the
// original rationale plus at most the LATEST attack. We strip on the LAST marker only (so a rationale
// that legitimately QUOTES a marker phrase is not truncated). Attack/note text cannot re-introduce a
// parseable marker: sanitizeAttack now breaks the ` — <marker>: ` delimiter (collapses the em-dash),
// so the ONLY markers in `why` are the real per-round appends plus any in the original (unsanitized)
// rationale. The LAST-marker split then both PREVENTS accretion (each round strips the prior append
// before re-appending — `why` is stable round-over-round) AND preserves a rationale that quotes a marker.
export function baseWhy(why) {
  const s = String(why ?? '').replace(/ \(reopened: [^)]*\)\s*$/, '')
    .replace(/ — still-open \(adjudicator did not run[^)]*\)\s*$/, '')
    .replace(/ — REGRESSED after fix \(no detail[^)]*\)\s*$/, '')
    .replace(/ — UNVERIFIED \(adjudicator could not tell[^)]*\)\s*$/, '')
  const re = / — (?:fix incomplete(?: \([^)]*\))?|REGRESSED after fix|UNVERIFIED \(adjudicator could not tell\)): /g
  let last = -1, m
  while ((m = re.exec(s))) last = m.index
  return last === -1 ? s : s.slice(0, last)
}

// Case-insensitive Critical/High gate. LEDGER_ITEM.severity has no enum (deliberately — clamping it
// would fail the whole prior-round ledger load and silently degrade re-review to a first pass), so a
// drifted `critical`/`CRITICAL` value must still trip the red-team gate. Exact-match `=== 'Critical'`
// would silently skip red-team on such a prior.
export function isHighSeverity(sev) { return ['critical', 'high'].includes(String(sev ?? '').trim().toLowerCase()) }

// Pure red-team verdict handling for a "resolved" Critical/High prior. Returns the possibly-
// adjusted adjudication plus degradation flags; the caller does the logging/counting.
export function classifyRedTeam(f, adj, rt) {
  if (!isHighSeverity(f.severity)) return { adj, died: false, overturned: false, invalid: false }
  if (rt == null) return { adj: { ...adj, note: `${adj.note || ''} [red-team did not run — agent died; resolved on the adjudicator's attack pass alone]`.trim() }, died: true, overturned: false, invalid: false }
  const atk = sanitizeAttack(rt.attack)
  if (rt.defeated && !atk) return { adj: { ...adj, note: `${adj.note || ''} [red-team claimed defeat with no attack — invalid verdict discarded; resolved on the adjudicator's attack pass alone]`.trim() }, died: false, overturned: false, invalid: true }
  if (rt.defeated) return { adj: { ...adj, status: 'still-open', attack: `(red-team) ${atk}` }, died: false, overturned: true, invalid: false }
  return { adj, died: false, overturned: false, invalid: false }
}

// Pure per-finding dispatch: map a finding + its adjudication result (r may be null) to a track
// and a ledger-ready entry. Caller pushes entry onto adjudicated[track] and does logging.
export function adjudicateOne(f, r) {
  const located = { ...f, line: r?.currentLine || f.line }
  const attack = sanitizeAttack(r?.attack)
  if (r == null) return { track: 'stillOpen', adjudicatorDied: true, entry: { ...located, why: `${baseWhy(f.why)} — still-open (adjudicator did not run — agent died; kept still-open by default)` } }
  const status = r.status || 'still-open'
  if (status === 'resolved' && attack) return { track: 'stillOpen', demoted: true, entry: { ...located, why: `${baseWhy(f.why)} — fix incomplete (adjudicator reported attack despite resolved): ${attack}` } }
  if (status === 'resolved') return { track: 'resolved', entry: { ...located, disposition: 'closed', ...(r.note ? { note: sanitizeAttack(r.note) } : {}) } }
  // An adjudication that could not reach a conclusion is NOT a fix. Route it to still-open — the
  // same direction a dead adjudicator takes — and mark `why` so a reader of the report can see the
  // item was carried without verification rather than confirmed still broken.
  if (status === 'cannot-tell') {
    const note = sanitizeAttack(r.note) || sanitizeAttack(r.attack)
    return { track: 'stillOpen', cannotTell: true, entry: { ...located, why: `${baseWhy(f.why)} — UNVERIFIED (adjudicator could not tell): ${note || 'no reason returned'}` } }
  }
  if (status === 'regressed') { const note = sanitizeAttack(r.note); return { track: 'regressed', entry: { ...located, why: note ? `${baseWhy(f.why)} — REGRESSED after fix: ${note}` : `${baseWhy(f.why)} — REGRESSED after fix (no detail returned by adjudicator)` } } }
  // still-open, and every status the schema does not know: an unrecognised verdict is an UNKNOWN,
  // and an unknown must never land on the resolved track.
  return { track: 'stillOpen', entry: attack ? { ...located, why: `${baseWhy(f.why)} — fix incomplete: ${attack}` } : located }
}

// Whether a "resolved" verdict is worth an independent red-team pass. A resolved verdict that
// ALREADY carries an attack is self-contradictory — adjudicateOne demotes it — so red-teaming it
// wastes an opus call and lets the red-team overwrite the adjudicator's own attack. Only a genuinely
// clean resolved (no attack) gets red-teamed. Emptiness is judged on the SANITIZED attack so a
// markdown-only "attack" counts as none.
export function shouldRedTeam(r) {
  return r?.status === 'resolved' && !sanitizeAttack(r.attack)
}

// The coarse identity used to decide whether a lens finding is ALREADY on the adjudicate track:
// file + ruleId, case- and whitespace-normalised. Empty when either half is missing — a finding
// with no ruleId cannot be keyed this way, and the caller falls back to the exact matcher.
export function carriedKey(f) {
  const file = String(f?.file ?? '').trim().toLowerCase()
  const ruleId = String(f?.ruleId ?? '').trim().toLowerCase()
  return file && ruleId ? `${file}\u0000${ruleId}` : ''
}

// The prior a freshly-discovered finding is ALREADY tracked by, or null. `priors` is the still-live
// adjudicate track (still-open / regressed / carried / retired).
//
// WHY FILE+RULEID AND NOT A TITLE MATCH. On a full re-scan the lenses see the whole diff and
// re-invent every prior as a fresh finding. The old test — matchesPrior, which requires file and
// ruleId to match AND the titles to overlap by 0.6 — recognised 2 of 59 such re-discoveries on a
// measured branch, because two agents describing the same defect rarely reuse each other's words.
// The other 57 were appended to the ledger alongside the prior they duplicate. Every carried
// finding costs one adjudicator call next round, so the ledger — and the bill — grew round over
// round. Dropping the title threshold entirely is what stops the accretion.
//
// THE COST, AND WHERE IT IS PAID. file+ruleId is coarser than the old test, so two GENUINELY
// DISTINCT defects that share a file and a rule collapse into one ledger entry. That would be a
// silent loss — a prior does not have to be PRUNED to vanish, it vanishes the round it RESOLVES,
// and `adjudicated.resolved` is deliberately not written to the next ledger. Within a round the
// collapse is already safe (the caller never dedups against the resolved track), but a finding
// absorbed in round N whose host resolves in round N+1 would be unrecorded and untracked — and on
// an incremental round its site is out of the lens base, so nothing re-discovers it.
//
// So absorption is not free and not silent: the absorbed finding LANDS — as a clause on the host's
// `why` (absorbInto), which is a persisted ledger field. The host therefore cannot leave the ledger
// without an adjudicator that was told, by file:line and title, that a second defect was reported
// at this site. The clause is written INTO the base rationale, ahead of the per-round markers, so
// baseWhy's marker-stripping cannot take it away again.
//
// `fallbackMatch` (the workflow passes matchesPrior) is used only when the finding or the prior has
// no usable file+ruleId key: without a ruleId the coarse key would collapse everything in a file.
export function findCarrier(f, priors, fallbackMatch) {
  const key = carriedKey(f)
  return (priors || []).find(p => {
    const pk = carriedKey(p)
    if (key && pk) return key === pk
    return typeof fallbackMatch === 'function' ? !!fallbackMatch(f, p) : false
  }) || null
}

// True when `f` (a finding the lenses just discovered) is already tracked by one of `priors`.
export function alreadyCarried(f, priors, fallbackMatch) {
  return !!findCarrier(f, priors, fallbackMatch)
}

// How many absorbed reports are named individually on one host before the rest collapse to a count.
// Not a prune: past the cap the host still says a further N reports landed here, so "this site holds
// more than one defect" survives — only the extra file:line/title detail is traded for a bounded
// `why`, which is re-interpolated into every subsequent prompt and rendered in the report.
export const ABSORBED_MAX = 3

// The absorbed finding's landing place: the host's BASE `why`, extended by one bounded clause.
// Re-absorbing the identical report is a no-op, so a defect the lenses re-discover every round does
// not grow the string round over round. The clause shape is deliberately unlike the ` — <marker>: `
// shape baseWhy parses, so it is never mistaken for a per-round append and stripped.
export function noteAbsorbed(baseText, f) {
  const base = String(baseText ?? '')
  const mark = ' — also reported at '
  const clause = `${mark}${sanitizeAttack(f?.file) || '?'}:${Number(f?.line) || 0}: ${sanitizeAttack(f?.title) || 'untitled'}`
  if (base.includes(clause)) return base
  if (base.split(mark).length - 1 < ABSORBED_MAX) return base + clause
  const overflow = / — \(\+(\d+) more report\(s\) at this site\)/
  const m = base.match(overflow)
  return `${m ? base.replace(overflow, '') : base} — (+${m ? Number(m[1]) + 1 : 1} more report(s) at this site)`
}

// Record `f` on its host's `why`. baseWhy is a PREFIX function (every rule it applies strips a
// TRAILING marker), so the base can be extended and this round's marker suffix re-attached
// unchanged — which is what keeps the clause alive across rounds: next round's baseWhy strips the
// marker and keeps everything the clause sits in.
export function absorbInto(hostWhy, f) {
  const s = String(hostWhy ?? '')
  const base = baseWhy(s)
  return noteAbsorbed(base, f) + s.slice(base.length)
}
