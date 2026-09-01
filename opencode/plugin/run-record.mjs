// Observability run-record helpers for the opencode adapter. Plain JS (no opencode imports) so it
// is node --test-able. The opencode plugin is NOT sandboxed: this module reads the clock and writes
// files directly, so there is no logger agent (unlike the Claude Code workflows). opencode records
// are a deterministic subset of the shared schema: no findings.bySeverity, no outputTokens.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Worst-signal-wins, mirroring the Claude Code workflows' verdict precedence.
export function parseVerdict(text) {
  const t = String(text || '')
  // Word boundaries (and the verdict emoji) so prose like "no blocking issues" / "unblocked"
  // doesn't collide with the Block keyword. Worst signal still wins (Block before Warning).
  if (/⛔|\b(?:Block|At-risk|UB-found)\b/i.test(t)) return 'Block'
  if (/⚠️|\b(?:Warning|Concerns)\b/i.test(t)) return 'Warning'
  // A dimension whose tooling was absent checked nothing and says so with `INCOMPLETE (not run)`.
  // That must not land in the Approve bucket: an Approve is a claim about what was NOT found, and
  // it only holds over what was actually looked at. Anchored to the full verdict phrase, not to the
  // bare word: this runs over an agent's entire free text, where prose like "coverage of untested
  // paths is incomplete" is ordinary — and a false INCOMPLETE teaches readers to ignore the marker.
  if (/INCOMPLETE\s*\(\s*not run\s*\)/i.test(t)) return 'INCOMPLETE (not run)'
  // Six of the audit dimensions have no agent file: their only instruction is a prompt string, so a
  // model can report the fact in a wording we did not anticipate — `INCOMPLETE — cargo-hack is not
  // installed`, `INCOMPLETE (not-run)`. Those must NOT fall through to Approve; an unrecognised
  // verdict defaulting to the permissive outcome is exactly what worstVerdict() in lib/run-record.mjs
  // refuses. The discriminator is shape, not vocabulary: the prose sense is an ADJECTIVE and is
  // followed on its own line by the word it qualifies ("INCOMPLETE coverage of the feature
  // powerset"), and is normally lowercase besides ("the docs are incomplete"); a verdict is not —
  // it is shouted and then terminated by punctuation, a table pipe, or the end of the line. So:
  // uppercase, and NOT followed on the same line by a word — WITH one exception. The mandated
  // wording is `INCOMPLETE (not run)`, and a model that drops the parentheses writes `INCOMPLETE
  // not run`: space-then-letter, and the shape test alone would send the prescribed vocabulary,
  // minus its punctuation, straight to Approve. So a small closed set of continuations is admitted
  // explicitly — the words a REASON opens with (not / no / never / nothing / none, run, and the
  // "it was absent" family). None of them is a noun an adjective would qualify, so admitting them
  // does not reopen the prose false positive.
  if (/\bINCOMPLETE\b(?:[ \t]*\(?[ \t]*(?:[Nn](?:ot|o|one|othing|ever)|[Rr]un|[Dd]ue|[Bb]ecause|[Ss]ince|[Cc]annot|[Uu]n(?:able|available)|[Mm]issing|[Aa]bsent|[Ss]kip(?:ped)?)\b|(?![ \t]+[A-Za-z]))/.test(t)) return 'INCOMPLETE (not run)'
  return 'Approve'
}

export function buildAuditRecord({ results, baseRef, hasUnsafe, synthesisText }) {
  const rs = Array.isArray(results) ? results : []
  return {
    schemaVersion: 1,
    runtime: 'opencode',
    kind: 'workflow',
    name: 'rust-audit',
    verdict: parseVerdict(synthesisText),
    findings: null,
    nested: false,
    via: null,
    scout: { baseRef: baseRef || '', hasUnsafe: !!hasUnsafe },
    dimensions: rs.map((r) => ({ dimension: r.label, ran: !!r.ok, verdict: r.ok ? parseVerdict(r.text) : '' })),
    notRun: rs.filter((r) => !r.ok).map((r) => r.label),
  }
}

export function buildTriageRecord({ results }) {
  const rs = Array.isArray(results) ? results : []
  return {
    schemaVersion: 1,
    runtime: 'opencode',
    kind: 'workflow',
    name: 'triage-findings',
    verdict: '',
    findings: null,
    nested: false,
    via: null,
    dimensions: rs.map((r) => ({ dimension: r.label, ran: !!r.ok })),
    notRun: rs.filter((r) => !r.ok).map((r) => r.label),
  }
}

export function indexProjection(r) {
  return {
    schemaVersion: r.schemaVersion, runtime: r.runtime ?? null, ts: r.ts, kind: r.kind, name: r.name,
    project: r.project, commit: r.commit, dirty: r.dirty,
    verdict: r.verdict, findingsTotal: r.findings ? r.findings.total : null,
    nested: r.nested, via: r.via,
  }
}

function runsDir() {
  return process.env.CRAFT_RUNS_DIR || join(homedir(), '.craft', 'runs')
}

// Filesystem-safe UTC: YYYY-MM-DDTHH-MM-SSZ (drop millis, replace the time colons).
function tsStamp(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-')
}

async function sh(ctx, cmd) {
  try {
    const r = await ctx.$`bash -lc ${cmd}`.quiet()
    return (r.stdout?.toString?.() ?? String(r.stdout ?? '')).trim()
  } catch {
    return ''
  }
}

// Best-effort: stamp the runtime fields, write the detail file, append the index line. NEVER throws
// into the caller — observability must not break a workflow run.
export async function writeRecord(ctx, record) {
  try {
    const dir = runsDir()
    const ts = tsStamp(new Date())
    const project = ctx.worktree || ctx.directory || (await sh(ctx, 'pwd'))
    const commit = await sh(ctx, 'git rev-parse --short HEAD 2>/dev/null')
    const dirty = (await sh(ctx, 'git status --porcelain 2>/dev/null')).length > 0
    const full = { ...record, ts, project, commit, dirty }
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${ts}-${full.kind}-${full.name}.json`), JSON.stringify(full, null, 2) + '\n')
    appendFileSync(join(dir, 'index.jsonl'), JSON.stringify(indexProjection(full)) + '\n')
  } catch (e) {
    try { console.error(`craft observability: failed to write run record: ${e?.message ?? e}`) } catch { /* ignore */ }
  }
}
