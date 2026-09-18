// Preflight probe accounting — the mechanical half of the "ask each source once" rule.
//
// WHY THIS EXISTS, and what it does and does not achieve. The preflight prompt in
// workflows/review.js tells the agent, at length, to resolve CI coverage with exactly two
// SHA-scoped calls, to probe the tool inventory with one loop rather than one command per tool, and
// to open at most two workflow files. That prose is the whole enforcement: measured twice in this
// repo, a rule that lives only in a prompt is a rule the next model slips. The measured collapse of
// the preflight's share of a run (215s → part of a 168s average, 0.6% of a 179-agent run) proves
// the prose is being FOLLOWED right now; it proves nothing about whether it CAN be broken.
//
// The engine script runs in a sandbox with no filesystem and no Node API: it cannot call `git`,
// `gh` or `cargo` itself, so "let the code query the sources and hand the answers to the prompt"
// — the only construction that would make a repeat literally impossible — is unavailable. The shell
// belongs to the agent, and nothing the engine can do takes it away.
//
// So the mechanism here is the next thing down, and it is named honestly: the agent must DECLARE,
// in the structured answer the engine already parses, which sources it consulted and how many times
// — and the engine audits that declaration against a budget. A repeat stops being a matter of
// manners and becomes either (a) a schema-level mismatch the engine sees, names in the log and
// carries into the run record, or (b) a false declaration, which is a different and much louder
// failure than an undisciplined one. That makes a repeat VISIBLE AND ACCOUNTED, not impossible.
// Anyone reading this should not upgrade the claim: see the note on the `auditPreflightProbes`
// contract below.

// The per-source budget. A source is named by the QUESTION it answers, not by the command that
// answers it: two spellings of "which checks are green for this SHA" are one source, which is the
// whole point — the old failure mode was three routes to one answer, each looking like a fresh
// question. `max: 0` means the route is forbidden outright: it exists, it resolves the same
// question, and the prompt bans it because it resolves by BRANCH (empty on a review worktree) or
// hands back a PR whose head has moved.
export const PROBE_BUDGETS = {
  'ci-check-runs': { max: 1, what: 'gh api repos/{owner}/{repo}/commits/$SHA/check-runs' },
  'ci-commit-status': { max: 1, what: 'gh api repos/{owner}/{repo}/commits/$SHA/status' },
  'ci-pr-checks': { max: 0, what: 'gh pr checks — resolves by branch; forbidden, the SHA-scoped calls answer it' },
  'ci-pr-by-commit': { max: 0, what: 'gh api …/commits/$SHA/pulls — forbidden in preflight; the gate owns PR lookup' },
  'workflow-file': { max: 2, what: 'reading a .github/workflows/*.yml behind a green check' },
  'tool-inventory': { max: 2, what: 'the one-shot command -v loop (once bare, once under the runner prefix)' },
  'runner-verify': { max: 2, what: 'an instant <prefix>true / <prefix>rustc --version' },
  'blocker-probe': { max: 4, what: 'the grep/ls/test questions behind a compile blocker' },
  'repo-identity': { max: 2, what: 'git rev-parse HEAD / git remote get-url origin' },
}

// The block appended to the preflight prompt. It is generated from PROBE_BUDGETS rather than written
// out beside it: a budget the prompt does not name is a budget the agent is judged against without
// being told, which turns the audit into a trap instead of a contract.
export function probeDeclarationBlock() {
  const rows = Object.entries(PROBE_BUDGETS).map(([id, b]) => b.max === 0
    ? `   - \`${id}\`: FORBIDDEN (${b.what}) — declaring calls > 0 here is a violation, not a note`
    : `   - \`${id}\`: at most ${b.max} (${b.what})`)
  return `5. DECLARE YOUR PROBES. Return \`probes\`: one entry per source you consulted, \`{ "source": "<id>", "calls": <how many shell/API invocations you spent on it> }\`. Count every invocation, including ones that returned nothing. The ids and their budgets:
${rows.join('\n')}
   Use these ids EXACTLY; an id not on this list is itself reported as a violation, so a repeat cannot be relabelled into a fresh question. A source you did not consult is simply absent (do not declare it with \`calls: 0\`). THE ENGINE AUDITS THIS: an over-budget or forbidden or unrecognized source is named in the run's log and carried into its record. Declaring fewer calls than you made is a false report, which is worse than an over-budget honest one.`
}

// Violations of the declared budget, as human-readable lines. Empty array = clean.
//
// CONTRACT, stated so nobody upgrades it: this audits the DECLARATION, not the shell. A preflight
// that asks one source three times and declares one call passes here. What the audit buys is that
// the honest path and the disciplined path are now the same path, and that a breach has to be
// either declared or actively misreported — where before it was neither visible nor recorded.
export function auditPreflightProbes(pf) {
  if (!pf) return []
  const out = []
  const probes = Array.isArray(pf.probes) ? pf.probes : null
  if (!probes) {
    // Absent is a violation of its own: `probes` is required by the schema, so a missing list means
    // the answer did not come through the contract at all — and silence must not read as clean,
    // which is the exact shape of every observability defect this engine has shipped.
    out.push('preflight declared no `probes` list — the per-source budget could not be audited')
    return out
  }
  const seen = new Map()
  for (const p of probes) {
    const id = String((p && p.source) || '').trim()
    const calls = Number((p && p.calls) ?? 0)
    if (!id) { out.push('a `probes` entry has no `source`'); continue }
    if (!Object.prototype.hasOwnProperty.call(PROBE_BUDGETS, id)) {
      out.push(`unrecognized probe source \`${id}\` — not one of the declared ids, so its budget is unknown`)
      continue
    }
    // Two entries for one id are the repeat this exists to catch, split across rows. Summed, never
    // taken as the larger: splitting 3 calls into 2+1 would otherwise read as within a budget of 2.
    seen.set(id, (seen.get(id) ?? 0) + (Number.isFinite(calls) ? calls : 0))
  }
  for (const [id, total] of seen) {
    const { max, what } = PROBE_BUDGETS[id]
    if (max === 0 && total > 0) out.push(`forbidden probe source \`${id}\` used ${total}×: ${what}`)
    else if (total > max) out.push(`probe source \`${id}\` used ${total}×, budget ${max}: ${what}`)
  }
  return out
}
