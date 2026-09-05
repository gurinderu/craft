// The audit end to end, on a fake ctx.
//
// Why this file exists rather than more unit tests: removing the synthesis gate from `runRustAudit`
// left the whole suite green, because every test covered the HELPER and none covered its use. That
// is the shape this repo keeps meeting — a fix applied in one place and observed in another — and
// the only thing that closes it is exercising the path the user actually takes.
//
// Writing to the real store is not acceptable from a test, so `CRAFT_RUNS_DIR` is pointed at a temp
// directory. It is read at call time, so this is airtight rather than hopeful.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runRustAudit } from './rust-audit.ts'

// `$` is Bun's shell used as a tagged template; every call in the audit is a read-only probe whose
// failure the code already tolerates, so answering "" for all of them is faithful.
const shell = () => Object.assign(() => ({ quiet: async () => ({ stdout: '' }) }), {})

function fakeCtx(answerFor) {
  const seen = []
  return {
    seen,
    directory: '/repo',
    worktree: '/repo',
    $: shell(),
    client: {
      session: {
        create: async () => ({ id: 's' }),
        prompt: async ({ body }) => {
          const agent = body?.agent ?? ''
          const isSynthesis = /consolidating a Rust audit/.test(body?.parts?.[0]?.text ?? '')
          seen.push(isSynthesis ? 'synthesis' : agent || 'dimension')
          const text = answerFor({ agent, isSynthesis })
          return { parts: [{ type: 'text', text }] }
        },
      },
    },
  }
}

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'craft-store-'))
  const prev = process.env.CRAFT_RUNS_DIR
  process.env.CRAFT_RUNS_DIR = dir
  return Promise.resolve(fn(dir)).finally(() => {
    if (prev === undefined) delete process.env.CRAFT_RUNS_DIR
    else process.env.CRAFT_RUNS_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  })
}

const record = dir => JSON.parse(readFileSync(join(dir, readdirSync(dir).find(f => f.endsWith('.json'))), 'utf8'))

test('a refusing synthesis is not a report, and is not filed as a verdict', async () => {
  // The one path that used to be exempt from the branch's own rule. A refusal is non-empty, so it
  // became the report AND was read for a verdict — parseVerdict falls through to Approve, so the
  // store recorded an approval for a run nobody consolidated.
  await withStore(async dir => {
    const ctx = fakeCtx(({ isSynthesis }) =>
      isSynthesis ? 'I am not able to consolidate this audit.' : 'checked\n\nVERDICT: APPROVE')
    const report = await runRustAudit(ctx, {})
    assert.match(report, /INCOMPLETE \(not run\) — the audit was not consolidated/, 'the reader is told')
    assert.ok(!/^I am not able/.test(report), 'and is not handed the refusal as the report')
    assert.match(record(dir).verdict, /INCOMPLETE/, 'and the store agrees with what the reader saw')
    // Emitted as a FIELD, not merely used to pick the verdict. The comment justifying the removal
    // of the echo guard offered "the record already carries `synthesized`" as a reason it was safe,
    // and it did not — a reader of the store could not tell a consolidated audit from an
    // unconsolidated one.
    assert.equal(record(dir).synthesized, false, 'the store says the consolidation never landed')
  })
})

test('the reader is told WHY the synthesis failed, not merely that it did', async () => {
  // A refusal, a timeout and an errored session are three different things to do next, and the
  // single-call path printed one sentence for all three: `runAnswering` returned {ok, text} and
  // dropped both the cause and the text. The fan-out path keeps them on purpose; this one was held
  // to the same gate but not the same reporting.
  await withStore(async () => {
    const ctx = fakeCtx(({ isSynthesis }) =>
      isSynthesis ? 'I am not able to consolidate this audit.' : 'checked\n\nVERDICT: APPROVE')
    const refused = await runRustAudit(ctx, {})
    assert.match(refused, /answered, but without the VERDICT: line/, 'a refusal is named as an unanswered one')
    assert.match(refused, /I am not able to consolidate/, 'and its own words are shown')
  })

  await withStore(async () => {
    const ctx = fakeCtx(({ isSynthesis }) => (isSynthesis ? '' : 'checked\n\nVERDICT: APPROVE'))
    const silent = await runRustAudit(ctx, {})
    assert.match(silent, /produced no output/, 'silence is named as silence')
    assert.ok(!/without the VERDICT: line/.test(silent), 'and is not confused with an unanswered reply')
  })
})

test('an echoed synthesis cannot lift the record above what the dimensions said', async () => {
  // Three echo guards were tried here and deleted; this is what stands in their place, stated as
  // what it is. A reply that refuses while quoting the results back CAN still be shown to the
  // reader as the report — it carries the blob's own VERDICT lines, and no cheap test told that
  // from a faithful merge without also rejecting faithful merges. What cannot happen is the thing
  // that mattered: buildAuditRecord rolls worst-wins over the dimensions, so an echo ending in
  // APPROVE cannot bury a Block one of them reported.
  await withStore(async dir => {
    const ctx = fakeCtx(({ isSynthesis, agent }) => {
      if (isSynthesis) return null
      return agent === 'rust-security-scanner'
        ? '- use-after-free in src/x.rs:10\n\nVERDICT: BLOCK'
        : `- ${agent}: nothing found\n\nVERDICT: APPROVE`
    })
    const inner = ctx.client.session.prompt
    ctx.client.session.prompt = async (req) => {
      const text = req?.body?.parts?.[0]?.text ?? ''
      if (/consolidating a Rust audit/.test(text)) {
        const blob = text.slice(text.indexOf('RESULTS:') + 'RESULTS:'.length).trim()
        return { parts: [{ type: 'text', text: `I cannot consolidate this. The results were:\n\n${blob}` }] }
      }
      return inner(req)
    }
    await runRustAudit(ctx, {})
    assert.equal(record(dir).verdict, 'Block', 'the reported Block survives an echoed consolidation')
  })
})

test('a faithful consolidation that reuses the input lines is used, not thrown away', async () => {
  // The side that costs more when it is wrong, and the one every echo guard got wrong: the prompt
  // orders "only merge what is given" and asks for each finding tagged with its location, so a real
  // consolidation of a small audit is largely lines lifted from the blob. Rejecting it throws the
  // whole audit away under an INCOMPLETE banner and hands the reader the raw blob — which is the
  // fallback the guard existed to avoid.
  await withStore(async dir => {
    const ctx = fakeCtx(({ isSynthesis, agent }) => {
      if (!isSynthesis) {
        return `- ${agent}: src/a.rs:10 unbounded growth in the retry buffer\n- ${agent}: src/b.rs:22 the lock is held across an await point\n\nVERDICT: APPROVE`
      }
      return null
    })
    const inner = ctx.client.session.prompt
    ctx.client.session.prompt = async (req) => {
      const text = req?.body?.parts?.[0]?.text ?? ''
      if (/consolidating a Rust audit/.test(text)) {
        const findings = text.split('\n').filter(l => l.startsWith('- '))
        const merged = [
          '# Rust audit',
          '',
          '## Findings by severity, each tagged with its dimension and location',
          // One input heading quoted in passing — legitimate, and the case that pins the guard's
          // threshold at two rather than one.
          (text.split('\n').find(l => /^###[ \t]/.test(l.trim())) ?? '').trim(),
          ...findings,
          '',
          '## Fix first',
          '1. The await-point lock is the one that can deadlock under load; take it after.',
          '',
          'VERDICT: WARNING',
        ].join('\n')
        return { parts: [{ type: 'text', text: merged }] }
      }
      return inner(req)
    }
    const report = await runRustAudit(ctx, {})
    assert.match(report, /Fix first/, 'the consolidation is used')
    assert.ok(!/was not consolidated/.test(report), 'and is not thrown away as a republication')
    assert.equal(record(dir).verdict, 'Warning')
  })
})

test('a real synthesis is used, and the store matches it', async () => {
  await withStore(async dir => {
    const ctx = fakeCtx(({ isSynthesis }) =>
      isSynthesis ? '# Audit\n\nall dimensions clean\n\nVERDICT: APPROVE' : 'checked\n\nVERDICT: APPROVE')
    const report = await runRustAudit(ctx, {})
    assert.match(report, /all dimensions clean/)
    assert.ok(!/was not consolidated/.test(report))
    assert.equal(record(dir).verdict, 'Approve')
    assert.equal(record(dir).synthesized, true, 'and says so when it did')
  })
})

test('a dimension that answers without a verdict is not counted as having run', async () => {
  // The headline defect of the branch, exercised through the real entry point rather than the
  // dispatcher alone: a session that says something but answers nothing must not become an Approve.
  await withStore(async dir => {
    const ctx = fakeCtx(({ agent, isSynthesis }) => {
      if (isSynthesis) return 'consolidated\n\nVERDICT: APPROVE'
      return agent === 'rust-security-scanner' ? 'I cannot run those tools here.' : 'checked\n\nVERDICT: APPROVE'
    })
    await runRustAudit(ctx, {})
    const r = record(dir)
    const security = (r.dimensions ?? []).find(d => d.dimension === 'security')
    assert.ok(security, 'the dimension is present in the record')
    assert.equal(security.ran, false, 'and is marked as not having run')
    assert.match(r.verdict, /INCOMPLETE/, 'so the audit as a whole is incomplete, not approved')
  })
})
